"""Build src/data/nace.json from the NACE Rev. 2 list in spec/nace/ (PDF).

Requires `pdftotext` (poppler-utils).   python3 scripts/build_nace.py
Codes are also given in TPT format (field 148): section letter + digits without dots, e.g. K6419.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
pdf = root / "spec/nace/NACE_Rev2_Sept2019.pdf"
text = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True, check=True).stdout

SECTION = re.compile(r"^SECTION ([A-U]) [—-] (.+)$")
CODE = re.compile(r"^(\d{2}(?:\.\d{1,2})?)\s+(.+?)(?:\s+\d{4}\*?)?\s*$")
SKIP = re.compile(r"^(NACE REV\. 2|n\.e\.c\.|\s*$)")

items, section = [], None
last = None
for raw in text.splitlines():
    line = raw.strip()
    if SKIP.match(line):
        last = None if not line else last
        continue
    m = SECTION.match(line)
    if m:
        section = m.group(1)
        items.append({"code": section, "nace": section, "level": "section", "section": section, "label": m.group(2).strip().capitalize()})
        last = items[-1]
        continue
    m = CODE.match(line)
    if m and section:
        code = m.group(1)
        level = {2: "division", 4: "group", 5: "class"}[len(code)]
        items.append({"code": section + code.replace(".", ""), "nace": code, "level": level, "section": section, "label": m.group(2).strip()})
        last = items[-1]
    elif last and last["level"] == "section" and line.isupper():
        last["label"] = (last["label"] + " " + line).capitalize()  # wrapped section title
    elif last and last["level"] != "section":
        last["label"] += " " + re.sub(r"\s+\d{4}\*?$", "", line)  # wrapped label

# The supplied PDF ends after section T. Section U is part of NACE Rev. 2 and is needed for
# extraterritorial/supranational issuers, so it is added here and marked as a supplement.
if not any(i["code"] == "U" for i in items):
    label = "Activities of extraterritorial organisations and bodies"
    for code, nace, level in (("U", "U", "section"), ("U99", "99", "division"), ("U990", "99.0", "group"), ("U9900", "99.00", "class")):
        items.append({"code": code, "nace": nace, "level": level, "section": "U", "label": label, "supplement": "Not in the supplied PDF; added from NACE Rev. 2 section U"})

counts = {lvl: sum(1 for i in items if i["level"] == lvl) for lvl in ("section", "division", "group", "class")}
expected = {"section": 21, "division": 88, "group": 272, "class": 615}
if counts != expected:
    print(f"WARNING: counts {counts} differ from NACE Rev. 2 totals {expected}", file=sys.stderr)
(root / "src/data/nace.json").write_text(json.dumps({
    "classification": "NACE Rev. 2",
    "source": "spec/nace/NACE_Rev2_Sept2019.pdf (supplied by the project owner)",
    "tptFormat": "Section letter + code digits without dots (TPT field 148)",
    "counts": counts,
    "items": items,
}, ensure_ascii=False, indent=0) + "\n")
print(counts)
