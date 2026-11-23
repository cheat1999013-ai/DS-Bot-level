from pathlib import Path
root = Path(__file__).resolve().parent.parent
out = root / '.tmp-verify/group-schedule-repair-candidate'
source = (root / 'src/client/schedules.js').read_text(encoding='utf-8')
path = out / 'src/client/schedules.js'
base = path.read_text(encoding='utf-8')
def block(text, start, end):
    a = text.index(start)
    b = text.index(end, a)
    return text[a:b]
def replace(old, new):
    global base
    if base.count(old) != 1: raise ValueError('ambiguous replacement')
    base = base.replace(old, new)
replace(block(base, 'const nextText =', 'const pad ='), block(source, 'const nextText =', 'const pad ='))
replace(block(base, 'function TaskForm(', '// Settings has no schedule service'), block(source, 'export function TaskForm(', '// Settings has no schedule service'))
replace(block(base, 'export function SchedulesPage(', '// A Bot\'s tasks'), block(source, 'export function SchedulesPage(', '// A Bot\'s tasks'))
replace("  const choices = group ? roster.rooms : roster.bots\n", "  const choices = group ? roster.rooms : [...roster.bots, ...roster.rooms]\n")
replace("        choices.map(item => h('option', { key: item.id, value: item.id }, item.name)))),", "        group ? choices.map(item => h('option', { key: item.id, value: item.id }, item.name)) : [\n          h('optgroup', { key: 'bots', label: t('Bots') }, roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),\n          roster.rooms.length ? h('optgroup', { key: 'rooms', label: t('Group chats') }, roster.rooms.map(room => h('option', { key: room.id, value: room.id }, room.name))) : null])),")
replace("t('New Bot reminder')", "t('New task')")
path.write_text(base, encoding='utf-8')
print('group card UI merged; ordinary group and bot reminders retained')
