# Frozen `cl100k_base` token corpus

The holdout files at this directory's root are acceptance-only. `calibration/` is disjoint and is used only to derive the fixed estimator calibration.

- Canonical upstream repository: https://github.com/openai/tiktoken
- Homepage: https://github.com/openai/tiktoken#readme
- Pinned release: https://pypi.org/project/tiktoken/0.7.0/ (`pip install tiktoken==0.7.0`)
- Invocation: `python` importing `tiktoken`
- Encoding: `cl100k_base`
- Resolved artifact: `tiktoken-0.7.0-cp311-cp311-macosx_11_0_arm64.whl`
- SHA-256: `084cec29713bc9d4189a937f8a35dbdfa785bd1235a34c1124fe2323821ee93f`

Regenerate frozen counts with:

```sh
python -c 'import json,pathlib,tiktoken; root=pathlib.Path("packages/dashboard/src/lib/__tests__/fixtures/token-corpus"); enc=tiktoken.get_encoding("cl100k_base"); files=["example.ts","view.tsx","settings.json","notes.md"]; print(json.dumps({"encoding":"cl100k_base","counts":{f:len(enc.encode((root/f).read_text())) for f in files}},indent=2))'
```
