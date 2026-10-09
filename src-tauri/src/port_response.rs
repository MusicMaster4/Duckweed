//! Adapt shared pages without buffering uploads, event streams or HTML bodies.
use super::{header, http, invalid, local_url, PREFIX};
use http::framing;
use lol_html::{element, html_content::ContentType, HtmlRewriter, Settings};
use std::io::{self, BufReader, Read, Write};
use std::net::TcpStream;

fn route_url(value: &str, primary: u16, prefix: &str) -> Option<String> {
    local_url(value, primary).or_else(|| {
        (value.starts_with('/')
            && !value.starts_with("//")
            && !value.starts_with(PREFIX)
            && !prefix.is_empty())
        .then(|| format!("{prefix}{value}"))
    })
}

fn adapt_csp(value: &str, nonce: &str) -> String {
    let mut directives: Vec<Vec<String>> = value
        .split(';')
        .map(|part| part.split_whitespace().map(str::to_string).collect())
        .filter(|part: &Vec<String>| !part.is_empty())
        .collect();
    let fallback = directives
        .iter()
        .find(|d| d[0].eq_ignore_ascii_case("default-src"))
        .map(|d| d[1..].to_vec());
    if !directives
        .iter()
        .any(|d| d[0].eq_ignore_ascii_case("script-src"))
    {
        if let Some(sources) = fallback {
            let mut script = vec!["script-src".to_string()];
            script.extend(sources);
            directives.push(script);
        }
    }
    for directive in &mut directives {
        let name = directive[0].to_ascii_lowercase();
        if name.ends_with("-src") || name.ends_with("-src-elem") || name == "form-action" {
            for source in directive.iter_mut().skip(1) {
                if local_url(source, 1).is_some() {
                    *source = "'self'".into();
                }
            }
        }
        if name == "script-src" || name == "script-src-elem" {
            // Adding a nonce disables unsafe-inline. Keep existing inline apps working.
            let inline = directive.iter().any(|s| s == "'unsafe-inline'")
                && !directive
                    .iter()
                    .any(|s| s.starts_with("'nonce-") || s.starts_with("'sha"));
            if !inline {
                directive.retain(|s| s != "'none'");
                directive.push(format!("'nonce-{nonce}'"));
            }
        }
    }
    directives
        .into_iter()
        .map(|d| d.join(" "))
        .collect::<Vec<_>>()
        .join("; ")
}

fn stream_html(
    reader: &mut dyn Read,
    client: &mut impl Write,
    primary: u16,
    prefix: &str,
    nonce: &str,
) -> io::Result<()> {
    let script = format!(
        "<script nonce=\"{nonce}\">{}</script>",
        include_str!("port_sharing.js").replace("__DUCKWEED_PRIMARY_PORT__", &primary.to_string())
    );
    let mut injected = false;
    let mut output_error = None;
    let disconnected = std::cell::Cell::new(false);
    {
        let mut rewriter = HtmlRewriter::new(
            Settings {
                element_content_handlers: vec![element!("*", |el| {
                    let tag = el.tag_name();
                    // Preserve the original doctype and document element. Fragments get
                    // the bootstrap before their first element, full pages inside head.
                    if !injected && tag != "html" {
                        if tag == "head" {
                            el.prepend(&script, ContentType::Html);
                        } else {
                            el.before(&script, ContentType::Html);
                        }
                        injected = true;
                    }
                    for attr in ["href", "src", "action", "formaction", "poster", "data"] {
                        if let Some(value) = el.get_attribute(attr) {
                            if let Some(url) = route_url(&value, primary, prefix) {
                                el.set_attribute(attr, &url)?;
                            }
                        }
                    }
                    if tag == "meta"
                        && el
                            .get_attribute("http-equiv")
                            .is_some_and(|v| v.eq_ignore_ascii_case("content-security-policy"))
                    {
                        if let Some(value) = el.get_attribute("content") {
                            el.set_attribute("content", &adapt_csp(&value, nonce))?;
                        }
                    }
                    Ok(())
                })],
                ..Settings::default()
            },
            |bytes: &[u8]| {
                if !bytes.is_empty() && output_error.is_none() {
                    let result = write!(client, "{:x}\r\n", bytes.len())
                        .and_then(|_| client.write_all(bytes))
                        .and_then(|_| client.write_all(b"\r\n"));
                    if let Err(error) = result {
                        output_error = Some(error);
                        disconnected.set(true);
                    }
                }
            },
        );
        let mut buffer = [0; 16 * 1024];
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            rewriter.write(&buffer[..count]).map_err(io::Error::other)?;
            if disconnected.get() {
                break;
            }
        }
        rewriter.end().map_err(io::Error::other)?;
    }
    if let Some(error) = output_error {
        return Err(error);
    }
    client.write_all(b"0\r\n\r\n")
}

pub(in crate::ports) fn forward_response(
    target: &mut TcpStream,
    client: &mut TcpStream,
    request: &[u8],
    primary: u16,
) -> io::Result<()> {
    let request = std::str::from_utf8(request).map_err(|_| invalid())?;
    let request_path = request.split_whitespace().nth(1).unwrap_or("/");
    let prefix = request_path
        .strip_prefix(PREFIX)
        .and_then(|r| r.split_once('/'))
        .map(|(port, _)| format!("{PREFIX}{port}"))
        .unwrap_or_default();
    let mut target = BufReader::new(target);
    loop {
        let mut head = Vec::new();
        loop {
            let line = http::line(&mut target)?;
            let end = line == b"\r\n";
            head.extend(line);
            if head.len() > 64 * 1024 {
                return Err(invalid());
            }
            if end {
                break;
            }
        }
        let raw = std::str::from_utf8(&head).map_err(|_| invalid())?;
        let status: u16 = raw
            .split_whitespace()
            .nth(1)
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?;
        if (100..200).contains(&status) {
            client.write_all(&head)?;
            if status == 101 {
                io::copy(&mut target, client)?;
                return Ok(());
            }
            continue;
        }
        let framing = framing(raw, false)?;
        let bodyless = request.starts_with("HEAD ") || matches!(status, 204 | 304);
        let encoding = header(raw, "content-encoding")
            .unwrap_or("identity")
            .to_ascii_lowercase();
        let html = !bodyless
            && status != 206
            && header(raw, "content-type")
                .is_some_and(|v| v.to_ascii_lowercase().starts_with("text/html"))
            && matches!(encoding.as_str(), "identity" | "gzip" | "deflate" | "br");
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let mut output = String::new();
        for (index, line) in raw.trim_end_matches("\r\n").split("\r\n").enumerate() {
            if index > 0 {
                let (name, value) = line.split_once(':').ok_or_else(invalid)?;
                let lower = name.to_ascii_lowercase();
                let value = value.trim();
                if matches!(lower.as_str(), "connection" | "keep-alive") {
                    continue;
                }
                if html
                    && matches!(
                        lower.as_str(),
                        "content-length"
                            | "content-encoding"
                            | "transfer-encoding"
                            | "etag"
                            | "content-md5"
                            | "digest"
                            | "content-digest"
                            | "trailer"
                            | "cache-control"
                    )
                {
                    continue;
                }
                if html
                    && matches!(
                        lower.as_str(),
                        "content-security-policy" | "content-security-policy-report-only"
                    )
                {
                    output.push_str(&format!("{name}: {}\r\n", adapt_csp(value, &nonce)));
                    continue;
                }
                if lower == "location" {
                    if let Some(url) = route_url(value, primary, &prefix) {
                        output.push_str(&format!("{name}: {url}\r\n"));
                        continue;
                    }
                }
                if lower == "access-control-allow-origin" && local_url(value, primary).is_some() {
                    if let Some(origin) = header(request, "origin").filter(|origin| {
                        reqwest::Url::parse(origin)
                            .ok()
                            .is_some_and(|url| Some(url.authority()) == header(request, "host"))
                    }) {
                        output.push_str(&format!("{name}: {origin}\r\n"));
                        continue;
                    }
                }
                if lower == "set-cookie" {
                    let cookie = value
                        .split(';')
                        .enumerate()
                        .filter_map(|(i, part)| {
                            if i > 0 {
                                if let Some((key, val)) = part.trim().split_once('=') {
                                    if key.eq_ignore_ascii_case("domain")
                                        && matches!(
                                            val.trim()
                                                .trim_start_matches('.')
                                                .to_ascii_lowercase()
                                                .as_str(),
                                            "localhost" | "127.0.0.1" | "[::1]" | "0.0.0.0"
                                        )
                                    {
                                        return None;
                                    }
                                    if key.eq_ignore_ascii_case("path")
                                        && val.starts_with('/')
                                        && !prefix.is_empty()
                                        && !val.starts_with(PREFIX)
                                    {
                                        return Some(format!(" Path={prefix}{val}"));
                                    }
                                }
                            }
                            Some(part.to_string())
                        })
                        .collect::<Vec<_>>()
                        .join(";");
                    output.push_str(&format!("{name}: {cookie}\r\n"));
                    continue;
                }
            }
            output.push_str(line);
            output.push_str("\r\n");
        }
        if html {
            output.push_str("Transfer-Encoding: chunked\r\nCache-Control: no-store\r\n");
        }
        output.push_str("Connection: close\r\n\r\n");
        client.write_all(output.as_bytes())?;
        if bodyless {
            return Ok(());
        }
        if html {
            let body = http::Body::new(&mut target, framing);
            let mut decoded: Box<dyn Read + '_> = match encoding.as_str() {
                "gzip" => Box::new(flate2::read::MultiGzDecoder::new(body)),
                "deflate" => Box::new(flate2::read::ZlibDecoder::new(body)),
                "br" => Box::new(brotli::Decompressor::new(body, 16 * 1024)),
                _ => Box::new(body),
            };
            stream_html(&mut decoded, client, primary, &prefix, &nonce)?;
        } else {
            http::copy_body(&mut target, client, framing)?;
        }
        return Ok(());
    }
}
