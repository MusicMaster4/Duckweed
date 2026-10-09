use std::path::{Path, PathBuf};

/// Resolve a local document before passing it to the OS default application.
/// Never hand executable files or arbitrary URI schemes to the shell handler.
pub fn resolve_document(path: &str) -> Result<PathBuf, String> {
    if path.chars().any(char::is_control) || path.starts_with("\\\\") || path.starts_with("//") {
        return Err("only local document paths can be opened".into());
    }
    let source = Path::new(path);
    if !source.is_absolute() {
        return Err("an absolute document path is required".into());
    }
    let resolved = source.canonicalize().map_err(|error| format!("could not open document: {error}"))?;
    if !resolved.is_file() || !is_document(&resolved) {
        return Err("only document and image files can be opened".into());
    }
    Ok(resolved)
}

fn is_document(path: &Path) -> bool {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(extension.as_str(),
        "html" | "htm" | "pdf" | "txt" | "md" | "csv" | "tsv" | "json" | "log"
        | "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
        | "doc" | "docx" | "odt" | "xls" | "xlsx" | "ods" | "ppt" | "pptx" | "odp"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_documents_and_images_but_rejects_programs() {
        for path in ["report.HTML", "preview.jpg", "notes.md", "budget.xlsx"] {
            assert!(is_document(Path::new(path)));
        }
        for path in ["run.exe", "run.cmd", "run.ps1", "run.js", "run.lnk", "no-extension"] {
            assert!(!is_document(Path::new(path)));
        }
    }

    #[test]
    fn requires_an_existing_absolute_local_document() {
        assert!(resolve_document("https://example.com/report.html").is_err());
        assert!(resolve_document("relative.html").is_err());
        assert!(resolve_document("\\\\server\\report.html").is_err());
        assert!(resolve_document("/tmp/report.html\0.exe").is_err());
        let directory = std::env::temp_dir().join(format!("duckweed-agent-document-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let document = directory.join("summary with spaces.html");
        let program = directory.join("program.exe");
        std::fs::write(&document, "<html></html>").unwrap();
        std::fs::write(&program, "not a document").unwrap();
        assert_eq!(resolve_document(document.to_str().unwrap()).unwrap(), document.canonicalize().unwrap());
        assert!(resolve_document(program.to_str().unwrap()).is_err());
        assert!(resolve_document(directory.to_str().unwrap()).is_err());
        std::fs::remove_file(document).unwrap();
        std::fs::remove_file(program).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
