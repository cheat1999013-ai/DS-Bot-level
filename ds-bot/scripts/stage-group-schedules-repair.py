import os
from pathlib import Path
import hashlib, json
root = Path(__file__).resolve().parent.parent
installed = Path(os.environ['DS_BOT_INSTALLED'])  # set to the installed ds-bot folder
manifest = json.loads((root / '.tmp-verify/taskflow-vertical-manifest-5.json').read_text(encoding='utf-8'))
out = root / '.tmp-verify/group-schedule-repair-candidate'
if out.exists():
    raise RuntimeError('Candidate already exists; no overwrite')
for name, digest in manifest['candidate'].items():
    data = (installed / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError('Installed baseline differs: ' + name)
    target = out / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
for name in ['src/host/group-schedules.js', 'src/host/schedules.js', 'src/host/taskflow/tools.js', 'src/host/taskflow/scheduler.js']:
    (out / name).write_bytes((root / name).read_bytes())
print(json.dumps({'candidate': str(out), 'baseline_files': len(manifest['candidate']), 'initial_source_transplants': 4}))
