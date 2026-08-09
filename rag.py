"""Local RAG over Ollama: document ingestion, chunking, embeddings and grounded Q&A with conversational memory.

Kept as its own module (rather than folded into server.py) so the retrieval logic is testable in
isolation. Talks to Ollama over its local HTTP API (http://localhost:11434) via urllib, matching the
rest of the project's stdlib-first style. pypdf is the one third-party dependency, needed for real
PDF text extraction (see tests/test_server.py's stated zero-dependency goal for the rest of the app).
"""

import json
import math
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from pypdf import PdfReader

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_CHAT_MODEL = os.getenv("OLLAMA_CHAT_MODEL", "llama3.1")
OLLAMA_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")

CHUNK_TARGET_CHARS = 800
CHUNK_OVERLAP_CHARS = 120
TOP_K = 5
MIN_SCORE = 0.15

SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md"}

SYSTEM_PROMPT = (
    "Eres el asistente de conocimiento personal de {name}. Respondes SOLO con base en los "
    "fragmentos de contexto que se te dan (sus documentos y conversaciones previas guardadas). "
    "Si el contexto no contiene la respuesta, dilo claramente en vez de inventar. "
    "Responde en espanol, de forma clara y directa, en pocas frases salvo que se pida mas detalle."
)


class RagUnavailableError(RuntimeError):
    """Raised when Ollama can't be reached or returns an unusable response."""


def _make_id(prefix):
    return f"{prefix}-{int(time.time() * 1000)}-{os.urandom(3).hex()}"


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def _ollama_post(path, payload, timeout=120):
    req = urllib.request.Request(
        f"{OLLAMA_HOST}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RagUnavailableError(f"No se pudo conectar con Ollama en {OLLAMA_HOST}: {exc}") from exc


def ollama_embed(text):
    result = _ollama_post("/api/embeddings", {"model": OLLAMA_EMBED_MODEL, "prompt": text})
    embedding = result.get("embedding")
    if not embedding:
        raise RagUnavailableError(f"Ollama no devolvio embedding (modelo {OLLAMA_EMBED_MODEL} instalado?)")
    return embedding


def ollama_chat(system_prompt, user_prompt):
    result = _ollama_post(
        "/api/chat",
        {
            "model": OLLAMA_CHAT_MODEL,
            "stream": False,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=180,
    )
    content = (result.get("message") or {}).get("content", "").strip()
    if not content:
        raise RagUnavailableError(f"Ollama no devolvio respuesta (modelo {OLLAMA_CHAT_MODEL} instalado?)")
    return content


def extract_pages(local_path, filename):
    ext = os.path.splitext((filename or "").lower())[1]
    if ext == ".pdf":
        reader = PdfReader(local_path)
        pages = []
        for i, page in enumerate(reader.pages, start=1):
            text = (page.extract_text() or "").strip()
            if text:
                pages.append((i, text))
        return pages
    with open(local_path, "r", encoding="utf-8", errors="ignore") as f:
        text = f.read().strip()
    return [(1, text)] if text else []


def chunk_text(text, target_chars=CHUNK_TARGET_CHARS, overlap=CHUNK_OVERLAP_CHARS):
    flat = " ".join(text.split())
    if not flat:
        return []
    if len(flat) <= target_chars:
        return [flat]
    chunks = []
    start = 0
    while start < len(flat):
        end = min(start + target_chars, len(flat))
        if end < len(flat):
            space = flat.rfind(" ", start + target_chars // 2, end)
            if space != -1:
                end = space
        piece = flat[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= len(flat):
            break
        start = max(end - overlap, start + 1)
    return chunks


def ingest_document(con, employee_id, filename, local_path):
    document_id = _make_id("doc")
    now = _utc_now()
    con.execute(
        "INSERT INTO documents (id, employee_id, filename, local_path, chunk_count, created_at) VALUES (?, ?, ?, ?, 0, ?)",
        (document_id, employee_id, filename, local_path, now),
    )
    chunk_count = 0
    for page_number, page_text in extract_pages(local_path, filename):
        for chunk in chunk_text(page_text):
            embedding = ollama_embed(chunk)
            con.execute(
                """
                INSERT INTO knowledge_chunks
                (id, employee_id, document_id, source_type, source_label, page_number, content, embedding, created_at)
                VALUES (?, ?, ?, 'document', ?, ?, ?, ?, ?)
                """,
                (_make_id("chunk"), employee_id, document_id, filename, page_number, chunk, json.dumps(embedding), now),
            )
            chunk_count += 1
    con.execute("UPDATE documents SET chunk_count = ? WHERE id = ?", (chunk_count, document_id))
    return chunk_count


def store_memory(con, employee_id, question, answer):
    text = f"Pregunta: {question}\nRespuesta: {answer}"
    embedding = ollama_embed(text)
    label = f"conversacion del {datetime.now(timezone.utc).strftime('%d/%m/%Y')}"
    con.execute(
        """
        INSERT INTO knowledge_chunks
        (id, employee_id, document_id, source_type, source_label, page_number, content, embedding, created_at)
        VALUES (?, ?, NULL, 'conversation', ?, NULL, ?, ?, ?)
        """,
        (_make_id("chunk"), employee_id, label, text, json.dumps(embedding), _utc_now()),
    )


def _cosine_similarity(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def retrieve(con, employee_id, query_embedding, top_k=TOP_K):
    rows = con.execute(
        "SELECT id, source_type, source_label, page_number, content, embedding FROM knowledge_chunks WHERE employee_id = ?",
        (employee_id,),
    ).fetchall()
    scored = [(_cosine_similarity(query_embedding, json.loads(row["embedding"])), row) for row in rows]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return scored[:top_k]


def answer_question(con, employee, question):
    employee_id = employee["id"]
    total = con.execute(
        "SELECT COUNT(*) AS n FROM knowledge_chunks WHERE employee_id = ?", (employee_id,)
    ).fetchone()["n"]
    if not total:
        return (
            "Aun no tengo materiales tuyos guardados. Mandame un PDF, nota o archivo de texto "
            "(.pdf/.txt/.md) y lo agrego a tu base de conocimiento personal.",
            [],
        )

    query_embedding = ollama_embed(question)
    top = [pair for pair in retrieve(con, employee_id, query_embedding) if pair[0] > MIN_SCORE]
    if not top:
        return ("No encontre nada relacionado con eso en tus materiales o conversaciones guardadas.", [])

    context_blocks = []
    sources = []
    for _score, row in top:
        if row["source_type"] == "document":
            label = row["source_label"] + (f" (pag. {row['page_number']})" if row["page_number"] else "")
            context_blocks.append(f"[Fuente: {label}]\n{row['content']}")
            if label not in sources:
                sources.append(label)
        else:
            context_blocks.append(f"[Contexto de conversacion previa]\n{row['content']}")

    prompt = "Contexto:\n\n" + "\n\n---\n\n".join(context_blocks) + f"\n\nPregunta: {question}"
    system = SYSTEM_PROMPT.format(name=employee["name"])
    answer = ollama_chat(system, prompt)
    return answer, sources
