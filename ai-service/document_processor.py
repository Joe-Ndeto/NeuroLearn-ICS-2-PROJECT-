from pathlib import Path
import sys

import pymupdf
from docx import Document
from pptx import Presentation


SUPPORTED_TYPES = {".pdf", ".docx", ".pptx"}


def extract_pdf(file_path):
    text = []

    document = pymupdf.open(file_path)

    for page in document:
        text.append(page.get_text())

    document.close()

    return "\n".join(text)


def extract_docx(file_path):
    document = Document(file_path)

    paragraphs = []

    for paragraph in document.paragraphs:
        if paragraph.text.strip():
            paragraphs.append(paragraph.text)

    return "\n".join(paragraphs)


def extract_pptx(file_path):
    presentation = Presentation(file_path)

    text = []

    for slide in presentation.slides:
        for shape in slide.shapes:
            if hasattr(shape, "text") and shape.text.strip():
                text.append(shape.text)

    return "\n".join(text)


def clean_text(text):
    lines = []

    for line in text.splitlines():
        line = " ".join(line.split())

        if line:
            lines.append(line)

    return "\n".join(lines)


def extract_document(file_path):
    file_path = Path(file_path)
    extension = file_path.suffix.lower()

    if extension not in SUPPORTED_TYPES:
        raise ValueError(f"Unsupported document format: {extension}")

    if extension == ".pdf":
        text = extract_pdf(file_path)

    elif extension == ".docx":
        text = extract_docx(file_path)

    elif extension == ".pptx":
        text = extract_pptx(file_path)

    return clean_text(text)


def process_document(file_path):
    file_path = Path(file_path)

    if not file_path.exists():
        raise FileNotFoundError(
            f"File not found: {file_path}"
        )

    text = extract_document(file_path)

    project_root = Path(__file__).resolve().parent.parent

    output_folder = project_root / "storage" / "processed"
    output_folder.mkdir(parents=True, exist_ok=True)

    output_file = output_folder / f"{file_path.stem}.txt"

    output_file.write_text(
        text,
        encoding="utf-8"
    )

    print(f"Processed: {file_path.name}")
    print(f"Saved: {output_file}")

    return output_file


if __name__ == "__main__":

    if len(sys.argv) != 2:
        print(
            "Usage: python document_processor.py <file_path>"
        )
        sys.exit(1)

    try:
        process_document(sys.argv[1])

        print("Document processing completed.")

    except Exception as error:
        print(
            f"Document processing failed: {error}"
        )

        sys.exit(1)