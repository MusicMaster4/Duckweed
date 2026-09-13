//! HTTP adaptation for a shared development app. Bodies, uploads, event streams
//! and WebSockets stay streaming; only the response headers are buffered.
use super::RouteResolver;
use std::io::{self, BufReader, Read, Write};
use std::net::TcpStream;

const PREFIX: &str = "/.duckweed/port/";

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid shared port request")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Shutdown, TcpListener};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn dependencies_require_live_authorization_and_keep_query_strings() {
        let routes: RouteResolver =
            Arc::new(|port| (port == 8000).then(|| vec!["127.0.0.1".into()]));
        let (head, port, addresses) = route_request(
            b"POST /.duckweed/port/8000/api?q=1 HTTP/1.1\r\nHost: shared.example\r\n\r\n",
            3000,
            &routes,
        )
        .unwrap();
        assert_eq!(port, 8000);
        assert!(addresses.is_some());
        assert!(head.starts_with(b"POST /api?q=1 HTTP/1.1\r\n"));
        assert!(route_request(
            b"GET /.duckweed/port/9999/private HTTP/1.1\r\n\r\n",
            3000,
            &routes
        )
        .is_err());
        assert!(
            route_request(b"GET /.duckweed/port/0/foo HTTP/1.1\r\n\r\n", 3000, &routes).is_err()
        );
    }

    #[test]
    fn same_origin_actions_are_adapted_but_foreign_origins_are_not_trusted() {
        let head = prepare_request(b"POST / HTTP/1.1\r\nHost: shared.example\r\nOrigin: https://shared.example\r\nX-Forwarded-Host: forged.example\r\nAccept-Encoding: gzip\r\n\r\n", "localhost:3000").unwrap();
        let head = String::from_utf8(head).unwrap();
        assert!(head.contains("Origin: http://localhost:3000\r\n"));
        assert!(head.contains("X-Forwarded-Host: localhost:3000\r\n"));
        assert!(!head.contains("forged.example"));
        assert!(!head.contains("gzip"));
        let foreign = prepare_request(
            b"POST / HTTP/1.1\r\nHost: shared.example\r\nOrigin: https://evil.example\r\n\r\n",
            "localhost:3000",
        )
        .unwrap();
        assert!(String::from_utf8(foreign)
            .unwrap()
            .contains("Origin: https://evil.example"));
    }

    fn response_through_proxy(response: &[u8], request: &[u8]) -> Vec<u8> {
        let origin = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut upstream = TcpStream::connect(origin.local_addr().unwrap()).unwrap();
        let (mut server, _) = origin.accept().unwrap();
        server.write_all(response).unwrap();
        server.shutdown(Shutdown::Write).unwrap();
        let edge = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut browser = TcpStream::connect(edge.local_addr().unwrap()).unwrap();
        browser
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let (mut client, _) = edge.accept().unwrap();
        forward_response(&mut upstream, &mut client, request, 3000).unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut result = Vec::new();
        browser.read_to_end(&mut result).unwrap();
        result
    }

    #[test]
    fn html_injection_fixes_lengths_and_csp_and_retains_the_page() {
        let result = response_through_proxy(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 15\r\nContent-Security-Policy: default-src 'self'; script-src 'self'\r\n\r\n<h1>Hello!</h1>", b"GET / HTTP/1.1\r\n\r\n");
        let result = String::from_utf8(result).unwrap();
        let (head, body) = result.split_once("\r\n\r\n").unwrap();
        assert_eq!(
            header(head, "content-length")
                .unwrap()
                .parse::<usize>()
                .unwrap(),
            body.len()
        );
        assert!(body.starts_with("<!doctype html><script nonce="));
        assert!(body.ends_with("<h1>Hello!</h1>"));
        let nonce = body
            .split("nonce=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        assert!(head.contains(&format!("'nonce-{nonce}'")));
    }

    #[test]
    fn chunked_html_stays_chunked_and_event_streams_are_unchanged() {
        let response = response_through_proxy(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", b"GET / HTTP/1.1\r\n\r\n");
        let response = String::from_utf8(response).unwrap();
        let (_, body) = response.split_once("\r\n\r\n").unwrap();
        let (size, remainder) = body.split_once("\r\n").unwrap();
        let size = usize::from_str_radix(size, 16).unwrap();
        assert_eq!(&remainder[size..], "\r\n5\r\nhello\r\n0\r\n\r\n");
        let sse = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: update\n\n";
        assert_eq!(
            response_through_proxy(sse, b"GET /events HTTP/1.1\r\n\r\n"),
            sse
        );
    }

    #[test]
    fn interim_responses_websockets_and_binary_data_keep_their_framing() {
        let response = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n\x00\xff\x01";
        assert_eq!(
            response_through_proxy(response, b"POST / HTTP/1.1\r\n\r\n"),
            response
        );
        let websocket = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n\x81\x02ok";
        assert_eq!(
            response_through_proxy(websocket, b"GET /ws HTTP/1.1\r\n\r\n"),
            websocket
        );
    }

    #[test]
    fn redirects_and_local_cookie_domains_work_on_the_public_host() {
        let response = response_through_proxy(b"HTTP/1.1 302 Found\r\nLocation: http://localhost:8000/login?q=1\r\nSet-Cookie: session=ok; Domain=localhost; Path=/; HttpOnly\r\nContent-Length: 0\r\n\r\n", b"GET / HTTP/1.1\r\n\r\n");
        let response = String::from_utf8(response).unwrap();
        assert!(response.contains("Location: /.duckweed/port/8000/login?q=1"));
        assert!(response.contains("Set-Cookie: session=ok; Path=/; HttpOnly"));
        let response = response_through_proxy(
            b"HTTP/1.1 302 Found\r\nLocation: /login\r\nContent-Length: 0\r\n\r\n",
            b"GET /.duckweed/port/8000/private HTTP/1.1\r\n\r\n",
        );
        assert!(String::from_utf8(response)
            .unwrap()
            .contains("Location: /.duckweed/port/8000/login"));
    }
}

pub(super) fn route_request(
    head: &[u8],
    primary: u16,
    routes: &RouteResolver,
) -> io::Result<(Vec<u8>, u16, Option<Vec<String>>)> {
    let raw = std::str::from_utf8(head).map_err(|_| invalid())?;
    let (line, headers) = raw.split_once("\r\n").ok_or_else(invalid)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().ok_or_else(invalid)?;
    let path = parts.next().ok_or_else(invalid)?;
    let version = parts.next().ok_or_else(invalid)?;
    let Some(route) = path.strip_prefix(PREFIX) else {
        return Ok((head.to_vec(), primary, None));
    };
    let (port, path) = route.split_once('/').ok_or_else(invalid)?;
    let port: u16 = port.parse().map_err(|_| invalid())?;
    let addresses = routes(port).ok_or_else(invalid)?;
    Ok((
        format!("{method} /{path} {version}\r\n{headers}").into_bytes(),
        port,
        Some(addresses),
    ))
}

fn header<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    raw.split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.trim())
}

pub(super) fn prepare_request(head: &[u8], host: &str) -> io::Result<Vec<u8>> {
    let raw = std::str::from_utf8(head).map_err(|_| invalid())?;
    let public_host = header(raw, "host").unwrap_or("");
    let mut output = Vec::new();
    for (index, line) in raw.trim_end_matches("\r\n").split("\r\n").enumerate() {
        if index > 0 {
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("accept-encoding")
                    || name.eq_ignore_ascii_case("forwarded")
                    || name.to_ascii_lowercase().starts_with("x-forwarded-")
                    || name.eq_ignore_ascii_case("if-none-match")
                    || name.eq_ignore_ascii_case("if-modified-since")
                {
                    continue;
                }
                if name.eq_ignore_ascii_case("origin") || name.eq_ignore_ascii_case("referer") {
                    if let Ok(mut url) = reqwest::Url::parse(value.trim()) {
                        if url.authority() == public_host {
                            let local = reqwest::Url::parse(&format!("http://{host}"))
                                .map_err(|_| invalid())?;
                            let _ = url.set_scheme("http");
                            let _ = url.set_host(local.host_str());
                            let _ = url.set_port(local.port());
                            let value = if name.eq_ignore_ascii_case("origin") {
                                url.origin().ascii_serialization()
                            } else {
                                url.to_string()
                            };
                            write!(output, "{name}: {value}\r\n")?;
                            continue;
                        }
                    }
                }
            }
        }
        write!(output, "{line}\r\n")?;
    }
    write!(
        output,
        "Accept-Encoding: identity\r\nX-Forwarded-Host: {host}\r\nX-Forwarded-Proto: https\r\n\r\n"
    )?;
    Ok(output)
}

fn local_url(value: &str, primary: u16) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(
        url.host_str()?,
        "localhost" | "127.0.0.1" | "[::1]" | "0.0.0.0"
    ) {
        return None;
    }
    let port = url.port_or_known_default()?;
    let prefix = if port == primary {
        String::new()
    } else {
        format!("{PREFIX}{port}")
    };
    let query = url
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let fragment = url
        .fragment()
        .map(|fragment| format!("#{fragment}"))
        .unwrap_or_default();
    Some(format!("{prefix}{}{query}{fragment}", url.path()))
}

pub(super) fn forward_response(
    target: &mut TcpStream,
    client: &mut TcpStream,
    request: &[u8],
    port: u16,
) -> io::Result<()> {
    let request_path = std::str::from_utf8(request)
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .unwrap_or("/");
    let dependency_prefix = request_path
        .strip_prefix(PREFIX)
        .and_then(|route| route.split_once('/'))
        .map(|(port, _)| format!("{PREFIX}{port}"));
    let mut target = BufReader::new(target);
    loop {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            target.read_exact(&mut byte)?;
            head.push(byte[0]);
            if head.len() > 64 * 1024 {
                return Err(invalid());
            }
        }
        let raw = std::str::from_utf8(&head).map_err(|_| invalid())?;
        let status = raw.split_whitespace().nth(1).unwrap_or("");
        // Interim responses and WebSocket handshakes must retain their framing.
        if status.starts_with('1') {
            client.write_all(&head)?;
            if status == "101" {
                io::copy(&mut target, client)?;
                return Ok(());
            }
            continue;
        }
        let html = header(raw, "content-type")
            .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/html"))
            && header(raw, "content-encoding")
                .is_none_or(|value| value.eq_ignore_ascii_case("identity"))
            && !request.starts_with(b"HEAD ")
            && status != "204"
            && status != "304";
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let injection = if html {
            format!(
                "<!doctype html><script nonce=\"{nonce}\">{}</script>",
                include_str!("port_sharing.js")
                    .replace("__DUCKWEED_PRIMARY_PORT__", &port.to_string())
            )
        } else {
            String::new()
        };
        let chunked = header(raw, "transfer-encoding")
            .is_some_and(|value| value.eq_ignore_ascii_case("chunked"));
        let mut output = String::new();
        for (index, line) in raw.trim_end_matches("\r\n").split("\r\n").enumerate() {
            if index > 0 {
                if let Some((name, value)) = line.split_once(':') {
                    if html
                        && (name.eq_ignore_ascii_case("etag")
                            || name.eq_ignore_ascii_case("content-md5"))
                    {
                        continue;
                    }
                    if html && name.eq_ignore_ascii_case("content-length") {
                        let length: usize = value.trim().parse().map_err(|_| invalid())?;
                        output
                            .push_str(&format!("Content-Length: {}\r\n", length + injection.len()));
                        continue;
                    }
                    if html && name.eq_ignore_ascii_case("content-security-policy") {
                        let mut directives: Vec<String> = value
                            .split(';')
                            .map(|part| part.trim().to_string())
                            .collect();
                        let default = directives
                            .iter()
                            .find_map(|part| part.strip_prefix("default-src "))
                            .map(str::to_owned);
                        let mut script = false;
                        for directive in &mut directives {
                            if directive.starts_with("script-src ")
                                || directive.starts_with("script-src-elem ")
                            {
                                if directive.starts_with("script-src ") {
                                    script = true;
                                }
                                directive.push_str(&format!(" 'nonce-{nonce}'"));
                            }
                        }
                        if !script {
                            if let Some(default) = default {
                                directives.push(format!("script-src {default} 'nonce-{nonce}'"));
                            }
                        }
                        output.push_str(&format!("{name}: {}\r\n", directives.join("; ")));
                        continue;
                    }
                    if name.eq_ignore_ascii_case("location") {
                        if let Some(location) = local_url(value.trim(), port) {
                            output.push_str(&format!("Location: {location}\r\n"));
                            continue;
                        }
                        if value.trim().starts_with('/') && !value.trim().starts_with("//") {
                            if let Some(prefix) = &dependency_prefix {
                                output.push_str(&format!("Location: {prefix}{}\r\n", value.trim()));
                                continue;
                            }
                        }
                    }
                    if name.eq_ignore_ascii_case("set-cookie") {
                        let cookie = value
                            .split(';')
                            .filter(|part| {
                                !part.trim().split_once('=').is_some_and(|(key, value)| {
                                    key.eq_ignore_ascii_case("domain")
                                        && matches!(
                                            value.trim().trim_start_matches('.'),
                                            "localhost" | "127.0.0.1" | "[::1]"
                                        )
                                })
                            })
                            .collect::<Vec<_>>()
                            .join(";");
                        output.push_str(&format!("{name}:{cookie}\r\n"));
                        continue;
                    }
                }
            }
            output.push_str(line);
            output.push_str("\r\n");
        }
        output.push_str("\r\n");
        client.write_all(output.as_bytes())?;
        if html {
            if chunked {
                write!(client, "{:x}\r\n{}\r\n", injection.len(), injection)?;
            } else {
                client.write_all(injection.as_bytes())?;
            }
        }
        io::copy(&mut target, client)?;
        return Ok(());
    }
}
