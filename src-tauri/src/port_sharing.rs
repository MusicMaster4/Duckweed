//! HTTP adaptation for a shared development app. Bodies, uploads, event streams
//! and WebSockets stay streaming; only the response headers are buffered.
use super::RouteResolver;
use std::io::{self, Write};
#[path = "port_http.rs"]
pub(super) mod http;
use http::framing;

const PREFIX: &str = "/.duckweed/port/";

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid shared port request")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Read};
    use std::net::{Shutdown, TcpListener, TcpStream};
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
    fn backend_requests_retain_the_frontend_origin_for_cors() {
        let request = b"POST /api HTTP/1.1\r\nHost: shared.example\r\nOrigin: https://shared.example\r\nReferer: https://shared.example/dashboard\r\n\r\n";
        let origin = browser_origin_host(request, 3000);
        let result = String::from_utf8(
            prepare_request_for_origin(request, "localhost:8000", &origin).unwrap(),
        )
        .unwrap();
        assert!(result.contains("Origin: http://localhost:3000\r\n"));
        assert!(result.contains("Referer: http://localhost:3000/dashboard\r\n"));
        assert!(result.contains("X-Forwarded-Host: localhost:8000\r\n"));
        assert!(result.contains("X-Forwarded-Proto: http\r\n"));
        let request = b"POST /auth HTTP/1.1\r\nHost: shared.example\r\nOrigin: https://shared.example\r\nReferer: https://shared.example/.duckweed/port/8000/login\r\n\r\n";
        let origin = browser_origin_host(request, 3000);
        let result = String::from_utf8(
            prepare_request_for_origin(request, "localhost:8000", &origin).unwrap(),
        )
        .unwrap();
        assert!(result.contains("Origin: http://localhost:8000\r\n"));
        assert!(result.contains("Referer: http://localhost:8000/login\r\n"));
    }

    fn decoded_body(response: &[u8]) -> String {
        let end = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let raw = std::str::from_utf8(&response[..end]).unwrap();
        let mut body = http::Body::new(
            BufReader::new(&response[end..]),
            framing(raw, false).unwrap(),
        );
        let mut decoded = String::new();
        body.read_to_string(&mut decoded).unwrap();
        decoded
    }

    #[test]
    fn html_injection_fixes_lengths_and_csp_and_retains_the_page() {
        let result = response_through_proxy(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 15\r\nContent-Security-Policy: default-src 'self'; script-src 'self'\r\n\r\n<h1>Hello!</h1>", b"GET / HTTP/1.1\r\n\r\n");
        let body = decoded_body(&result);
        let result = String::from_utf8(result).unwrap();
        let (head, _) = result.split_once("\r\n\r\n").unwrap();
        assert_eq!(header(head, "content-length"), None);
        assert_eq!(header(head, "transfer-encoding"), Some("chunked"));
        assert!(body.starts_with("<script nonce="));
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
        assert_eq!(decoded_body(&response), "hello");
        let sse = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: update\n\n";
        assert_eq!(
            response_through_proxy(sse, b"GET /events HTTP/1.1\r\n\r\n"),
            sse
        );
    }

    #[test]
    fn interim_responses_websockets_and_binary_data_keep_their_framing() {
        let response = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\n\x00\xff\x01";
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

    #[test]
    fn html_preserves_document_structure_and_routes_assets_forms_and_csp() {
        let html = "<!DOCTYPE html><html lang=\"en\"><head><title>App</title></head><body><img src=\"http://localhost:3000/icon.png\"><form action=\"//localhost:8000/login\"></form><script>window.works=true</script></body></html>";
        let result = response_through_proxy(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src http://localhost:8000\r\nContent-Length: {}\r\n\r\n{html}", html.len()).as_bytes(), b"GET / HTTP/1.1\r\n\r\n");
        let body = decoded_body(&result);
        assert!(body.starts_with("<!DOCTYPE html><html lang=\"en\"><head><script nonce="));
        assert_eq!(body.matches("<!DOCTYPE").count(), 1);
        assert!(body.contains("src=\"/icon.png\""));
        assert!(body.contains("action=\"/.duckweed/port/8000/login\""));
        let raw = std::str::from_utf8(&result).unwrap();
        assert!(raw.contains("script-src 'self' 'unsafe-inline'; connect-src 'self'\r\n"));
        assert!(body.contains("<script>window.works=true</script>"));
    }

    #[test]
    fn compressed_html_is_decoded_and_reframed() {
        let html = b"<!doctype html><html><head></head><body>compressed</body></html>";
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(html).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\n\r\n", compressed.len()).into_bytes();
        response.extend(compressed);
        let result = response_through_proxy(&response, b"GET / HTTP/1.1\r\n\r\n");
        let body = decoded_body(&result);
        assert!(body.contains("<head><script nonce="));
        assert!(body.ends_with("<body>compressed</body></html>"));
        assert!(!std::str::from_utf8(&result)
            .unwrap()
            .contains("Content-Encoding:"));
    }

    #[test]
    fn dependency_cookie_paths_redirects_and_cors_stay_on_the_public_origin() {
        let result = response_through_proxy(b"HTTP/1.1 302 Found\r\nLocation: //localhost:8000/login#step\r\nSet-Cookie: session=ok; Domain=.LOCALHOST; Path=/auth; HttpOnly\r\nAccess-Control-Allow-Origin: http://localhost:8000\r\nContent-Length: 0\r\n\r\n", b"GET /.duckweed/port/8000/auth HTTP/1.1\r\nHost: shared.example\r\nOrigin: https://shared.example\r\n\r\n");
        let result = String::from_utf8(result).unwrap();
        assert!(result.contains("Location: /.duckweed/port/8000/login#step"));
        assert!(result.contains("Set-Cookie: session=ok; Path=/.duckweed/port/8000/auth; HttpOnly"));
        assert!(result.contains("Access-Control-Allow-Origin: https://shared.example"));
    }

    #[test]
    fn head_and_no_content_responses_never_get_a_body() {
        for (request, response) in [
            (
                b"HEAD / HTTP/1.1\r\n\r\n".as_slice(),
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 500\r\n\r\n"
                    .as_slice(),
            ),
            (
                b"GET / HTTP/1.1\r\n\r\n".as_slice(),
                b"HTTP/1.1 204 No Content\r\nContent-Type: text/html\r\n\r\n".as_slice(),
            ),
        ] {
            let result = response_through_proxy(response, request);
            assert!(result.ends_with(b"\r\n\r\n"));
            assert!(!String::from_utf8(result).unwrap().contains("nonce="));
        }
    }

    #[test]
    fn framed_responses_finish_while_the_upstream_connection_stays_open() {
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcunexpected".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\nunexpected"
                .as_slice(),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let mut upstream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            upstream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let (mut server, _) = listener.accept().unwrap();
            server.write_all(response).unwrap();
            let edge = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let mut browser = TcpStream::connect(edge.local_addr().unwrap()).unwrap();
            let (mut client, _) = edge.accept().unwrap();
            forward_response(&mut upstream, &mut client, b"GET / HTTP/1.1\r\n\r\n", 3000).unwrap();
            client.shutdown(Shutdown::Write).unwrap();
            let mut result = Vec::new();
            browser.read_to_end(&mut result).unwrap();
            assert_eq!(decoded_body(&result), "abc");
            assert!(!String::from_utf8(result).unwrap().contains("unexpected"));
            drop(server);
        }
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
        return Ok((
            head.to_vec(),
            primary,
            Some(routes(primary).ok_or_else(invalid)?),
        ));
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

use http::header;

#[cfg(test)]
pub(super) fn prepare_request(head: &[u8], host: &str) -> io::Result<Vec<u8>> {
    prepare_request_for_origin(head, host, host)
}

pub(super) fn browser_origin_host(head: &[u8], primary: u16) -> String {
    let raw = std::str::from_utf8(head).unwrap_or("");
    let port = header(raw, "referer")
        .and_then(|value| reqwest::Url::parse(value).ok())
        .filter(|url| Some(url.authority()) == header(raw, "host"))
        .and_then(|url| {
            url.path()
                .strip_prefix(PREFIX)?
                .split_once('/')?
                .0
                .parse::<u16>()
                .ok()
        })
        .unwrap_or(primary);
    format!("localhost:{port}")
}

pub(super) fn prepare_request_for_origin(
    head: &[u8],
    host: &str,
    origin_host: &str,
) -> io::Result<Vec<u8>> {
    let raw = std::str::from_utf8(head).map_err(|_| invalid())?;
    framing(raw, true)?;
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
                            let local = reqwest::Url::parse(&format!("http://{origin_host}"))
                                .map_err(|_| invalid())?;
                            let _ = url.set_scheme("http");
                            let _ = url.set_host(local.host_str());
                            let _ = url.set_port(local.port());
                            let dependency =
                                format!("{PREFIX}{}/", local.port_or_known_default().unwrap_or(80));
                            if let Some(path) = url.path().strip_prefix(&dependency) {
                                let path = format!("/{path}");
                                url.set_path(&path);
                            }
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
        "Accept-Encoding: identity\r\nX-Forwarded-Host: {host}\r\nX-Forwarded-Proto: http\r\nX-Forwarded-Port: {}\r\n\r\n",
        host.rsplit(':').next().unwrap_or("80")
    )?;
    Ok(output)
}

fn local_url(value: &str, primary: u16) -> Option<String> {
    let absolute = if value.starts_with("//") {
        format!("http:{value}")
    } else {
        value.to_string()
    };
    let url = reqwest::Url::parse(&absolute).ok()?;
    if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
        return None;
    }
    if !matches!(
        url.host_str()?,
        "localhost" | "127.0.0.1" | "[::1]" | "0.0.0.0" | "[::]"
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

#[path = "port_response.rs"]
mod response;
pub(super) use response::forward_response;
