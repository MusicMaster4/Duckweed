//! Bounded HTTP/1 message framing. Never wait for EOF on a framed response,
//! and never forward a second request through an already authorized connection.
use std::io::{self, BufRead, Read, Write};

pub(in crate::ports) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid shared HTTP message")
}

pub(in crate::ports) fn header<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    raw.split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.trim())
}

#[derive(Clone, Copy)]
pub(in crate::ports) enum Framing {
    Length(u64),
    Chunked,
    Eof,
}

pub(in crate::ports) fn framing(raw: &str, request: bool) -> io::Result<Framing> {
    let lengths: Vec<_> = raw
        .lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .collect();
    let encodings: Vec<_> = raw
        .lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"))
        .collect();
    if lengths.len() > 1 || encodings.len() > 1 || (!lengths.is_empty() && !encodings.is_empty()) {
        return Err(invalid());
    }
    if let Some((_, encoding)) = encodings.first() {
        if !encoding.trim().eq_ignore_ascii_case("chunked") {
            return Err(invalid());
        }
        return Ok(Framing::Chunked);
    }
    if let Some((_, length)) = lengths.first() {
        let length = length.trim();
        if length.is_empty() || !length.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        return Ok(Framing::Length(length.parse().map_err(|_| invalid())?));
    }
    Ok(if request {
        Framing::Length(0)
    } else {
        Framing::Eof
    })
}

pub(in crate::ports) fn line(reader: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    reader.take(64 * 1024 + 1).read_until(b'\n', &mut line)?;
    if line.len() > 64 * 1024 || !line.ends_with(b"\r\n") {
        return Err(invalid());
    }
    Ok(line)
}

fn chunk_size(line: &[u8]) -> io::Result<u64> {
    let size = std::str::from_utf8(line)
        .map_err(|_| invalid())?
        .trim_end_matches("\r\n")
        .split(';')
        .next()
        .ok_or_else(invalid)?;
    if size.is_empty() || !size.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    u64::from_str_radix(size, 16).map_err(|_| invalid())
}

fn copy_exact(reader: &mut impl Read, writer: &mut impl Write, length: u64) -> io::Result<()> {
    if io::copy(&mut reader.take(length), writer)? != length {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "truncated shared HTTP body",
        ));
    }
    Ok(())
}

pub(in crate::ports) fn copy_body(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    framing: Framing,
) -> io::Result<()> {
    match framing {
        Framing::Length(length) => copy_exact(reader, writer, length),
        Framing::Eof => io::copy(reader, writer).map(|_| ()),
        Framing::Chunked => loop {
            let size_line = line(reader)?;
            let size = chunk_size(&size_line)?;
            writer.write_all(&size_line)?;
            if size == 0 {
                let mut total = 0;
                loop {
                    let trailer = line(reader)?;
                    total += trailer.len();
                    if total > 64 * 1024 {
                        return Err(invalid());
                    }
                    writer.write_all(&trailer)?;
                    if trailer == b"\r\n" {
                        return Ok(());
                    }
                }
            }
            copy_exact(reader, writer, size)?;
            let mut end = [0; 2];
            reader.read_exact(&mut end)?;
            if end != *b"\r\n" {
                return Err(invalid());
            }
            writer.write_all(&end)?;
        },
    }
}

/// Decodes transfer framing for streaming HTML adaptation only.
pub(in crate::ports) struct Body<R> {
    reader: R,
    framing: Framing,
    remaining: u64,
    ended: bool,
}

impl<R: BufRead> Body<R> {
    pub(in crate::ports) fn new(reader: R, framing: Framing) -> Self {
        Self {
            reader,
            framing,
            remaining: 0,
            ended: false,
        }
    }
}

impl<R: BufRead> Read for Body<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.ended {
            return Ok(0);
        }
        let count = match &mut self.framing {
            Framing::Eof => return self.reader.read(buffer),
            Framing::Length(left) => {
                if *left == 0 {
                    return Ok(0);
                }
                let limit = buffer.len().min((*left).min(usize::MAX as u64) as usize);
                let count = self.reader.read(&mut buffer[..limit])?;
                *left -= count as u64;
                count
            }
            Framing::Chunked => {
                if self.remaining == 0 {
                    self.remaining = chunk_size(&line(&mut self.reader)?)?;
                    if self.remaining == 0 {
                        let mut total = 0;
                        loop {
                            let trailer = line(&mut self.reader)?;
                            total += trailer.len();
                            if total > 64 * 1024 {
                                return Err(invalid());
                            }
                            if trailer == b"\r\n" {
                                break;
                            }
                        }
                        self.ended = true;
                        return Ok(0);
                    }
                }
                let limit = buffer
                    .len()
                    .min(self.remaining.min(usize::MAX as u64) as usize);
                let count = self.reader.read(&mut buffer[..limit])?;
                self.remaining -= count as u64;
                if self.remaining == 0 {
                    let mut end = [0; 2];
                    self.reader.read_exact(&mut end)?;
                    if end != *b"\r\n" {
                        return Err(invalid());
                    }
                }
                count
            }
        };
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated shared HTTP body",
            ));
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn rejects_ambiguous_or_invalid_request_framing() {
        for fields in [
            "Content-Length: 4\r\nTransfer-Encoding: chunked",
            "Content-Length: 4\r\nContent-Length: 4",
            "Content-Length: +4",
            "Content-Length: -1",
            "Transfer-Encoding: gzip, chunked",
        ] {
            assert!(framing(&format!("POST / HTTP/1.1\r\n{fields}\r\n\r\n"), true).is_err());
        }
    }

    #[test]
    fn copies_only_one_body_including_chunk_extensions_and_trailers() {
        for (framing, input, expected) in [
            (
                Framing::Length(3),
                "abcGET /private HTTP/1.1\r\n\r\n",
                "abc",
            ),
            (
                Framing::Chunked,
                "3;name=value\r\nabc\r\n0\r\nX-Checksum: ok\r\n\r\nGET /private HTTP/1.1\r\n\r\n",
                "3;name=value\r\nabc\r\n0\r\nX-Checksum: ok\r\n\r\n",
            ),
        ] {
            let mut output = Vec::new();
            copy_body(&mut Cursor::new(input), &mut output, framing).unwrap();
            assert_eq!(output, expected.as_bytes());
        }
    }

    #[test]
    fn truncated_bodies_fail_instead_of_appearing_complete() {
        for (framing, input) in [
            (Framing::Length(4), "abc"),
            (Framing::Chunked, "3\r\nabc\r\n"),
        ] {
            assert!(copy_body(&mut Cursor::new(input), &mut Vec::new(), framing).is_err());
            assert!(Body::new(Cursor::new(input), framing)
                .read_to_end(&mut Vec::new())
                .is_err());
        }
    }
}
