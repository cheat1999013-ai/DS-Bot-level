import os
from pathlib import Path
from difflib import unified_diff
import hashlib, json
root = Path(__file__).resolve().parent.parent
installed = Path(os.environ['DS_BOT_INSTALLED'])  # set to the installed ds-bot folder
candidate = root / '.tmp-verify/group-schedule-repair-candidate'
old = json.loads((root / '.tmp-verify/taskflow-vertical-manifest-5.json').read_text(encoding='utf-8'))['candidate']
files = list(old) + ['src/host/group-schedules.js']
changed = []
patches = []
for name in sorted(files):
    source = installed / name
    target = candidate / name
    old_bytes = source.read_bytes() if source.exists() else b''
    new_bytes = target.read_bytes()
    if name in old and hashlib.sha256(old_bytes).hexdigest() != old[name]:
        raise RuntimeError('Installed baseline changed: ' + name)
    if old_bytes == new_bytes: continue
    changed.append(name)
    if name != 'client.js':
        old_text = old_bytes.decode('utf-8').splitlines(keepends=True)
        new_text = new_bytes.decode('utf-8').splitlines(keepends=True)
        patches.extend(unified_diff(old_text, new_text, fromfile='a/'+name if source.exists() else '/dev/null', tofile='b/'+name))
(root / 'scripts/group-schedule-repair.patch').write_text(''.join(patches), encoding='utf-8', newline='')
result = {'baseline': old, 'candidate': {n:hashlib.sha256((candidate/n).read_bytes()).hexdigest() for n in files}, 'changed':changed}
(root / '.tmp-verify/group-schedule-repair-manifest.json').write_text(json.dumps(result, indent=2, ensure_ascii=False),encoding='utf-8')
print(json.dumps({'changed':changed,'count':len(files)}))
