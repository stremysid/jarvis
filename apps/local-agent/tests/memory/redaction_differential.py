"""Emit synthetic-fixture decisions for scripts/check-redaction-differential.mjs."""

import argparse
import json
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]


def expand(text: str) -> str:
    return (
        text.replace("<six>", "6" * 6)
        .replace("<eight>", "7" * 8)
        .replace("<four>", "4" * 4)
        .replace("<bearer>", "a" * 15 + "1")
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--policy", type=Path,
        default=ROOT / "apps/local-agent/jarvis_local/memory/projection_policy.py",
    )
    args = parser.parse_args()
    policy = runpy.run_path(str(args.policy))["redaction_would_change"]
    gaps = json.loads((ROOT / "tests/fixtures/redaction-gaps.json").read_text("utf-8"))
    legacy = json.loads((ROOT / "tests/fixtures/memory-projection-policy.json").read_text("utf-8"))
    cases = [(item["name"], item["text"]) for item in gaps]
    cases.extend((item["name"], expand(item["text"])) for item in legacy["redactionCases"])
    cases.extend(
        (f"ECMAScript whitespace {point}, template {index}", expand(template.replace("<space>", chr(point))))
        for point in legacy["jsWhitespaceCodePoints"]
        for index, template in enumerate(legacy["spaceTemplates"])
    )
    args.output.write_text(json.dumps([{"name": name, "refuse": policy(text)} for name, text in cases]), "utf-8")


if __name__ == "__main__":
    main()
