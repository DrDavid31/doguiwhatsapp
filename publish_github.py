import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO_NAME = os.getenv("GITHUB_REPO_NAME", "doguiwhatsapp")
OWNER = os.getenv("GITHUB_OWNER", "")
TOKEN = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
VISIBILITY_PRIVATE = os.getenv("GITHUB_PRIVATE", "true").lower() != "false"

IGNORED_NAMES = {
    ".env",
    "checador.db",
    "checador.db-shm",
    "checador.db-wal",
}
IGNORED_DIRS = {
    ".git",
    "__pycache__",
    "media",
}


def request_json(method, url, payload=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "doguiwhatsapp-publisher",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = response.read().decode("utf-8")
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API error {exc.code} for {url}: {detail}") from exc


def ensure_repo():
    if OWNER:
        repo_url = f"https://api.github.com/repos/{OWNER}/{REPO_NAME}"
        try:
            return request_json("GET", repo_url)
        except RuntimeError as exc:
            if "404" not in str(exc):
                raise

    payload = {
        "name": REPO_NAME,
        "private": VISIBILITY_PRIVATE,
        "description": "Checador de tiempo empresarial por WhatsApp con backend SQLite y webhook de Meta.",
        "auto_init": False,
    }
    try:
        return request_json("POST", "https://api.github.com/user/repos", payload)
    except RuntimeError as exc:
        if "already exists" not in str(exc).lower():
            raise
        user = request_json("GET", "https://api.github.com/user")
        return request_json("GET", f"https://api.github.com/repos/{user['login']}/{REPO_NAME}")


def should_upload(path):
    rel_parts = path.relative_to(ROOT).parts
    if any(part in IGNORED_DIRS for part in rel_parts):
        return False
    if path.name in IGNORED_NAMES:
        return False
    return path.is_file()


def file_sha(owner, repo, repo_path):
    encoded = "/".join(urllib.request.pathname2url(part) for part in repo_path.split("/"))
    try:
        data = request_json("GET", f"https://api.github.com/repos/{owner}/{repo}/contents/{encoded}")
        return data.get("sha")
    except RuntimeError as exc:
        if "404" in str(exc):
            return None
        raise


def upload_file(owner, repo, path):
    rel = path.relative_to(ROOT).as_posix()
    content = base64.b64encode(path.read_bytes()).decode("ascii")
    payload = {
        "message": f"Add {rel}",
        "content": content,
    }
    existing_sha = file_sha(owner, repo, rel)
    if existing_sha:
        payload["message"] = f"Update {rel}"
        payload["sha"] = existing_sha
    encoded = "/".join(urllib.request.pathname2url(part) for part in rel.split("/"))
    request_json("PUT", f"https://api.github.com/repos/{owner}/{repo}/contents/{encoded}", payload)
    print(f"uploaded {rel}")


def enable_pages(owner, repo):
    payload = {"source": {"branch": "main", "path": "/"}}
    try:
        request_json("GET", f"https://api.github.com/repos/{owner}/{repo}/pages")
        request_json("PUT", f"https://api.github.com/repos/{owner}/{repo}/pages", payload)
    except RuntimeError as exc:
        if "404" not in str(exc):
            raise
        request_json("POST", f"https://api.github.com/repos/{owner}/{repo}/pages", payload)
    print("github pages enabled")


def main():
    if not TOKEN:
        print("Falta GITHUB_TOKEN o GH_TOKEN con permiso repo.", file=sys.stderr)
        return 2
    repo = ensure_repo()
    owner = repo["owner"]["login"]
    name = repo["name"]
    for path in sorted(ROOT.rglob("*")):
        if should_upload(path):
            upload_file(owner, name, path)
    try:
        enable_pages(owner, name)
    except RuntimeError as exc:
        print(f"warning: no se pudo activar GitHub Pages automaticamente: {exc}", file=sys.stderr)
    print(repo["html_url"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
