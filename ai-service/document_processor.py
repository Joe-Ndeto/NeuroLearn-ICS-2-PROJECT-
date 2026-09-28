from pathlib import Path
import sys
import hashlib

import pymupdf
from docx import Document
from pptx import Presentation


SUPPORTED_TYPES = {".pdf", ".docx", ".pptx"}


def create_content_hash(text):
    normalized = " ".join(text.split()).lower()

    return hashlib.sha256(
        normalized.encode("utf-8")
    ).hexdigest()


def extract_pdf(file_path):
    text_sections = []
    seen_pages = set()

    document = pymupdf.open(file_path)

    try:
        for page_number, page in enumerate(document, start=1):
            page_text = page.get_text()

            if not page_text.strip():
                continue

            content_hash = create_content_hash(page_text)

            if content_hash in seen_pages:
                print(
                    f"Duplicate PDF page skipped: {page_number}"
                )
                continue

            seen_pages.add(content_hash)

            text_sections.append(page_text)

    finally:
        document.close()

    return "\n".join(text_sections)


def extract_docx(file_path):
    document = Document(file_path)

    paragraphs = []
    seen_paragraphs = set()

    for paragraph in document.paragraphs:

        paragraph_text = paragraph.text.strip()

        if not paragraph_text:
            continue

        content_hash = create_content_hash(
            paragraph_text
        )

        if content_hash in seen_paragraphs:
            continue

        seen_paragraphs.add(content_hash)

        paragraphs.append(paragraph_text)

    return "\n".join(paragraphs)


def extract_pptx(file_path):
    presentation = Presentation(file_path)

    text_sections = []
    seen_slides = set()

    for slide_number, slide in enumerate(
        presentation.slides,
        start=1
    ):

        slide_text = []

        for shape in slide.shapes:

            if hasattr(shape, "text"):

                shape_text = shape.text.strip()

                if shape_text:
                    slide_text.append(shape_text)

        combined_slide_text = "\n".join(
            slide_text
        )

        if not combined_slide_text.strip():
            continue

        content_hash = create_content_hash(
            combined_slide_text
        )

        if content_hash in seen_slides:
            print(
                f"Duplicate PowerPoint slide skipped: {slide_number}"
            )
            continue

        seen_slides.add(content_hash)

        text_sections.append(
            combined_slide_text
        )

    return "\n".join(text_sections)


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
        raise ValueError(
            f"Unsupported document format: {extension}"
        )

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

    project_root = (
        Path(__file__).resolve().parent.parent
    )

    output_folder = (
        project_root
        / "storage"
        / "processed"
    )

    output_folder.mkdir(
        parents=True,
        exist_ok=True
    )

    output_file = (
        output_folder
        / f"{file_path.stem}.txt"
    )

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

        process_document(
            sys.argv[1]
        )

        print(
            "Document processing completed."
        )

    except Exception as error:

        print(
            f"Document processing failed: {error}"
        )

        sys.exit(1)