"""Generate bundled ISO reference lists from the pycountry package
(which packages Debian's iso-codes data). Output is committed to the repo,
so this only needs to run when updating the lists.

    training/.venv/bin/pip install pycountry
    training/.venv/bin/python scripts/build_reference_data.py
"""
import json
from pathlib import Path

import pycountry

root = Path(__file__).resolve().parent.parent
version = getattr(pycountry, "__version__", None)
try:
    from importlib.metadata import version as _v
    version = _v("pycountry")
except Exception:
    pass

source = f"pycountry {version} (Debian iso-codes)"

countries = sorted(
    ({"code": c.alpha_2, "alpha3": c.alpha_3, "numeric": c.numeric, "name": c.name} for c in pycountry.countries),
    key=lambda c: c["code"],
)
currencies = sorted(
    ({"code": c.alpha_3, "numeric": c.numeric, "name": c.name} for c in pycountry.currencies),
    key=lambda c: c["code"],
)

(root / "src/data/iso3166.json").write_text(
    json.dumps({"standard": "ISO 3166-1", "source": source, "countries": countries}, ensure_ascii=False, indent=1) + "\n"
)
(root / "src/data/iso4217.json").write_text(
    json.dumps({"standard": "ISO 4217", "source": source, "currencies": currencies}, ensure_ascii=False, indent=1) + "\n"
)
print(f"{len(countries)} countries, {len(currencies)} currencies from {source}")
