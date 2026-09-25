#!/usr/bin/env python3
"""
独立证据复核（Phase 7）。

不信服务端自报的校验结果，直接打开上传目录里的**原始 PDF**，
取证据声称的那一页文本，确认 quote 是这一页的真实子串。

用法：python3 _p7_verify_evidence.py <payload.json> <uploadDir>
输出：{"total":n,"found":m,"items":[{"evidence_id":..,"ok":bool,...}]}
"""
import json
import os
import re
import sys

try:
    import fitz  # PyMuPDF
except Exception as e:  # pragma: no cover
    print(json.dumps({"error": f"PyMuPDF 不可用: {e}"}))
    sys.exit(0)


def norm(s: str) -> str:
    """折叠空白 + 统一引号，避免排版差异造成假阴性。"""
    s = s.replace("\u2019", "'").replace("\u2018", "'")
    s = s.replace("\u201c", '"').replace("\u201d", '"')
    s = s.replace("\u2013", "-").replace("\u2014", "-")
    return re.sub(r"\s+", " ", s).strip().lower()


def main():
    payload_path = sys.argv[1]
    upload_dir = sys.argv[2]
    with open(payload_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    items = payload.get("items", [])
    results = []

    # 把上传目录里的 PDF 建索引（按文件 hash 或文件名）
    pdf_index = {}
    for root, _dirs, files in os.walk(upload_dir):
        for fn in files:
            if fn.lower().endswith(".pdf"):
                pdf_index[fn] = os.path.join(root, fn)

    for it in items:
        rec = {"evidence_id": it.get("evidence_id"), "page": it.get("page"),
               "file_name": it.get("file_name"), "ok": False, "reason": ""}
        fname = it.get("file_name") or ""
        path = pdf_index.get(fname)
        if not path:
            # 退一步：按内容hash匹配文件名（保存时原名可能带前缀）
            cands = [p for f, p in pdf_index.items() if fname and fname in f]
            path = cands[0] if cands else None
        if not path:
            rec["reason"] = f"上传目录找不到 {fname}"
            results.append(rec)
            continue
        try:
            doc = fitz.open(path)
        except Exception as e:
            rec["reason"] = f"打开失败 {e}"
            results.append(rec)
            continue
        pno = int(it.get("page") or 0) - 1
        if pno < 0 or pno >= doc.page_count:
            rec["reason"] = f"页码 {it.get('page')} 超出 0..{doc.page_count}"
            doc.close()
            results.append(rec)
            continue
        page_text = norm(doc.load_page(pno).get_text("text"))
        quote = norm(it.get("content") or "")
        # 取前 60 字符做子串判定（尾部可能因分页截断）
        probe = quote[:60] if len(quote) > 60 else quote
        rec["ok"] = bool(probe) and probe in page_text
        if not rec["ok"]:
            rec["reason"] = "该页未找到该引文"
        doc.close()
        results.append(rec)

    found = sum(1 for r in results if r["ok"])
    print(json.dumps({"total": len(results), "found": found, "items": results},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
