/**
 * DS Bot — Skill Index (Hermes 记忆适配 · backend 卡).
 *
 * 独立可卸载：本文件 + taskflow.js 三行接线（1 import + 1 调用 + 3 个 READS 名）。
 * 不改 schema、不新增 Knowledge 实例、不接管 ctx.compaction、不碰 DSH 本体。
 *
 * 依据 hermes-skill-index/DESIGN.md：
 *   §1.2 三条权限门全部复用现有实现（availableSkills 等级门 / SQL+双哈希可见性门 / exec.agent 身份门）
 *   §2   8 大类闭集、skillTags() 四级、规则优先+模型兜底+人工改判
 *   §3   D1 自实现检索（谓词逐条复制 knowledge.js:165-166）、§3.2 排序键、§3.3 展示字段
 *   §4   D2 单群合并、D5 复用 similar/score、单事务只产 draft、幂等/冲突/跨群
 *   §5   失败与降级表、统一 {success:false,error,message}
 *   §6.1 install(rt,start,state) 形状（对齐 knowledge-runtime.js:68）
 *   §6.2 四工具契约 + projectIndexState 同一函数；工具按 caller 授权集裁剪、端点聚合降级
 *   §6.4 GET 只读端点、非 loopback 403、写方法 405、无请求体解析
 *
 * 身份只从 exec.agent 推导：工具层调 TaskflowService.scope(exec, group, {leader})。
 * 浏览器面板无 exec.agent，只读端点以 loopback 守卫为边界，绝不写库、绝不伪造身份。
 */
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SchedulerError } from './taskflow/scheduler.js'
import { skillTags } from './taskflow/skill-lifecycle.js'

export const STATE_ROUTE = '/api/ds-bot/skill-index/state'
export const SERVICE_NAME = 'skillIndex'
export const TOOL_NAMES = ['skill_index_search', 'skill_index_status', 'skill_index_classify', 'skill_index_merge']
export const READ_TOOL_NAMES = ['skill_index_search', 'skill_index_status', 'skill_index_classify']

/** §2.1 固定功能大类（8 个，闭集）。词表顺序即同分时的优先级。 */
export const CATEGORIES = ['设计', '代码', '测试', '运维', '数据', '文档', '研究', '协作']
const CATEGORY_RULES = {
  '设计': ['设计', '界面', 'ui', '布局', '配色', '视觉', '图标', '交互', '原型', '样式', 'ux'],
  '代码': ['代码', '实现', '函数', '模块', '接口', '重构', '编程', '脚本', '开发', '后端', '前端', '补丁', '编译'],
  '测试': ['测试', '断言', '用例', '回归', '验证', '验收', '覆盖率', '单测', 'mock'],
  '运维': ['部署', '运维', '监控', '服务器', '容器', '配置', '发布', '流水线', 'ci', '日志'],
  '数据': ['数据', '数据库', '索引', '查询', '统计', '表结构', 'sql', '迁移', '聚合'],
  '文档': ['文档', '说明', 'readme', '注释', '手册', '撰写', '编写', '目录'],
  '研究': ['研究', '调研', '分析', '对比', '评估', '探索', '实验', '溯源'],
  '协作': ['协作', '沟通', '流程', '分工', '评审', '同步', '交接', '排期'],
}
const RULE_THRESHOLD = 3

// ---------------------------------------------------------------------------
// 相似度：逐字复制 knowledge.js:47-58（模块私有，未 export），阈值同源 D5。
// ---------------------------------------------------------------------------
export const grams = value => {
  const chars = Array.from((String(value).toLowerCase().match(/[\p{L}\p{N}]/gu) ?? []).join(''))
  return new Set(Array.from({ length: Math.max(0, chars.length - 2) }, (_, i) => chars.slice(i, i + 3).join('')))
}
export const score = (a, b) => {
  const left = grams(a)
  const right = grams(b)
  if (!left.size || !right.size) return 0
  const overlap = [...left].filter(part => right.has(part)).length
  return overlap / (left.size + right.size - overlap)
}
export const similar = (a, b, threshold = 0.45) =>
  score(a.title, b.title) >= threshold && score(a.text, b.text) >= threshold

/** knowledge-runtime.js:9 的 skillDescription 语义（UI 文案与自动装配一致）。 */
export const skillDescription = row =>
  `${row.title} · ${(row.tags ?? []).join('、') || '待分类'}${row.lifecycle === 'forgetting' ? ' · 待遗忘（仍可调用）' : ''}`

const occurrences = (hay, needle) => {
  if (!needle) return 0
  const text = String(hay ?? '').toLowerCase()
  let count = 0, from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    count += 1
    from = at + needle.length
  }
  return count
}
const lifecycleRank = value => value === 'active' ? 2 : value === 'forgetting' ? 1 : 0
const tierRank = value => value === 'premium' ? 3 : value === 'excellent' ? 2 : 1

// ---------------------------------------------------------------------------
// §3 检索：D1 自实现过滤 + 排序，谓词逐条复制 knowledge.js:165-166
// ---------------------------------------------------------------------------
/**
 * view = { knowledge, scheduler, state, caller, scope, readOnly }
 * caller 来自 TaskflowService.scope(exec, group)（身份只从 exec.agent 推导）。
 */
export function indexSearch(view, args = {}) {
  const { knowledge, scheduler, state, caller } = view
  if (!knowledge) throw new SchedulerError('knowledge_unavailable', 'The taskflow knowledge store is not available')
  const requested = ['room', 'shared', 'all'].includes(args.scope) ? args.scope : 'room'
  const botId = caller.botId
  const ownRoom = caller.room
  const allRooms = state.rooms()
  const adminRooms = allRooms.filter(room => room.admin === botId)

  // §1.3 / §3.4：scope:'all' 仅主理（任 admin 的群集合）；成员静默降级 room
  let scopeApplied = requested
  let rooms = [ownRoom]
  if (requested === 'all') {
    if (adminRooms.length) { scopeApplied = 'all'; rooms = adminRooms }
    else { scopeApplied = 'room'; rooms = [ownRoom] }
  }

  // pool = 各授权 room 的 availableSkills(room, tier)：已含等级门/双审/共享哈希/retired 过滤
  const seen = new Set()
  const pool = []
  for (const room of rooms) {
    const tier = scheduler.botLevel(room.id, botId).tier
    const rows = knowledge.availableSkills(room.id, tier)
    rows.forEach((row, order) => {
      if (seen.has(row.id)) return
      seen.add(row.id)
      pool.push({ row, order, room })
    })
  }

  // 过滤谓词：逐条复制 knowledge.js:165-166（父类涵盖 + 小写包含）；空查询不抛 invalid_query
  const term = String(args.query ?? '').trim().toLowerCase()
  const normalized = skillTags(args.tags ?? [])
  const filters = normalized.filter(tag => !normalized.some(child => child.startsWith(`${tag}-`)))
  const matched = pool.filter(({ row }) => {
    const tags = row.tags ?? []
    const tagOk = filters.every(filter => tags.some(tag => tag === filter || tag.startsWith(`${filter}-`)))
    const termOk = !term || row.title.toLowerCase().includes(term)
      || String(row.text ?? '').toLowerCase().includes(term)
      || tags.some(tag => tag.toLowerCase().includes(term))
    return tagOk && termOk
  })

  // §3.2 排序键（at 用 availableSkills 的 ORDER BY 下标作秩，DESIGN §3.2 注）
  const decorated = matched.map(({ row, order, room }) => {
    const tags = row.tags ?? []
    const tagExact = filters.filter(filter => tags.some(tag => tag === filter)).length
    const tagCovered = filters.filter(filter =>
      !tags.some(tag => tag === filter) && tags.some(tag => tag.startsWith(`${filter}-`))).length
    const termScore = term
      ? 3 * occurrences(row.title, term)
        + 2 * tags.reduce((sum, tag) => sum + occurrences(tag, term), 0)
        + occurrences(row.text, term)
      : 0
    return { row, order, room, tagExact, tagCovered, termScore }
  })
  decorated.sort((a, b) =>
    b.tagExact - a.tagExact || b.tagCovered - a.tagCovered || b.termScore - a.termScore
    || lifecycleRank(b.row.lifecycle) - lifecycleRank(a.row.lifecycle)
    || tierRank(b.row.tier) - tierRank(a.row.tier)
    || b.order - a.order
    || String(a.row.id).localeCompare(String(b.row.id)))

  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50))
  let start = 0
  if (args.cursor) {
    const decoded = decodeCursor(args.cursor)
    if (decoded) {
      const at = decorated.findIndex(item => item.row.id === decoded.id)
      start = at >= 0 ? at + 1 : 0
    }
  }
  const page = decorated.slice(start, start + limit)
  const roomName = id => state.room(id)?.name ?? id
  const skills = page.map(({ row, room }) => ({
    id: row.id,
    room: row.room ?? room.id,
    room_name: roomName(row.room ?? room.id),
    tier: row.tier,
    title: row.title,
    tags: row.tags ?? [],
    lifecycle: row.lifecycle,
    score: row.score ?? null,
    scoringExempt: Boolean(row.scoringExempt),
    shared: Boolean(row.shared),
    description: skillDescription(row),
  }))
  const nextCursor = start + limit < decorated.length && page.length
    ? encodeCursor({ id: page[page.length - 1].row.id, k: [
      page[page.length - 1].tagExact, page[page.length - 1].tagCovered, page[page.length - 1].termScore,
    ] })
    : null
  return {
    level: scheduler.botLevel(ownRoom.id, botId),
    scope_applied: scopeApplied,
    skills,
    next_cursor: nextCursor,
  }
}

const encodeCursor = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
const decodeCursor = value => {
  try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')) }
  catch { return null }
}

// ---------------------------------------------------------------------------
// §2 自动分类：规则优先 → 模型兜底 → ['未分类']（只产建议，不写库）
// ---------------------------------------------------------------------------
function ruleClassify(row) {
  const title = String(row.title ?? '').toLowerCase()
  const text = String(row.text ?? '').toLowerCase()
  const tags = (row.tags ?? []).map(tag => String(tag).toLowerCase())
  let best = null, bestScore = 0
  for (const category of CATEGORIES) {
    let points = 0
    for (const word of CATEGORY_RULES[category]) {
      points += 3 * occurrences(title, word)
        + 2 * tags.reduce((sum, tag) => sum + occurrences(tag, word), 0)
        + occurrences(text, word)
    }
    if (points > bestScore) { bestScore = points; best = category }
  }
  return bestScore >= RULE_THRESHOLD ? { suggested: [best], score: bestScore } : null
}

const validSuggestion = value => {
  let tags
  try { tags = skillTags(value) } catch { return null }
  if (!tags.length || tags.includes('未分类')) return null
  return tags.every(tag => CATEGORIES.includes(tag.split('-')[0])) ? tags : null
}

/**
 * view.modelClassify 可选注入的 async 函数（无适配器/超时/限流 → catch 判 model_unavailable）。
 * 不写 skill_catalog.tags、不碰 owner_tags_hash（D4：改判唯一入口是 consolidate）。
 */
export function indexClassify(view, args = {}) {
  const { knowledge, caller } = view
  if (!knowledge) throw new SchedulerError('knowledge_unavailable', 'The taskflow knowledge store is not available')
  const id = String(args.id ?? '')
  const row = knowledge.db.prepare('SELECT id,title,text FROM candidates WHERE id=? AND room=?')
    .get(id, caller.room.id) ?? { id, title: '', text: '' }
  const tags = knowledge.lifecycle.catalog(id).tags
  const source = { ...row, tags }

  const rule = ruleClassify(source)
  if (rule) return { id, suggested: skillTags(rule.suggested), via: 'rule' }

  if (typeof view.modelClassify !== 'function') {
    return { id, suggested: ['未分类'], via: 'fallback', degraded: 'model_unavailable' }
  }
  let proposed
  try {
    proposed = view.modelClassify({
      categories: [...CATEGORIES], title: source.title, text: String(source.text ?? '').slice(0, 2000), tags,
    })
  } catch {
    return { id, suggested: ['未分类'], via: 'fallback', degraded: 'model_unavailable' }
  }
  const settle = value => {
    const ok = validSuggestion(value)
    return ok
      ? { id, suggested: ok, via: 'model' }
      : { id, suggested: ['未分类'], via: 'fallback', degraded: 'classify_fallback' }
  }
  // 同步适配器直接返回对象；异步 Promise 由工具层 await（execute 内已处理 thenable）
  if (proposed && typeof proposed.then === 'function') {
    return proposed.then(settle, () => ({
      id, suggested: ['未分类'], via: 'fallback', degraded: 'model_unavailable',
    }))
  }
  return settle(proposed)
}

// ---------------------------------------------------------------------------
// §4 合并：D2 单群、D5 similar/score 同源、单事务只产 draft
// ---------------------------------------------------------------------------
function clusterRows(rows) {
  const parent = rows.map((_, i) => i)
  const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]))
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (similar(rows[i], rows[j], 0.45)) union(i, j)
    }
  }
  const groups = new Map()
  rows.forEach((row, i) => {
    const key = find(i)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  })
  return [...groups.values()]
}

function nearestToMedoid(group, count) {
  const sim = (a, b) => (score(a.title, b.title) + score(a.text, b.text)) / 2
  let medoid = group[0], best = -1
  for (const row of group) {
    const avg = group.reduce((sum, other) => sum + sim(row, other), 0) / group.length
    if (avg > best) { best = avg; medoid = row }
  }
  return [...group].sort((a, b) => sim(medoid, b) - sim(medoid, a)).slice(0, count)
}

const sameSet = (a, b) => a.length === b.length &&
  [...a].sort().join('\u0000') === [...b].sort().join('\u0000')

function fail(code, message, details) {
  const error = new SchedulerError(code, message)
  if (details) error.details = details
  return error
}

/**
 * 只产 candidates(draft) + candidate_sources；不写 text/bot_review/owner_review。
 * 幂等优先于冲突检测；跨群来源在写库前拦截；事务中途失败整体回滚。
 */
export function indexMerge(view, args = {}) {
  const { knowledge, caller } = view
  if (view.readOnly) throw fail('read_only_host', 'Merge is unavailable on a read-only host')
  if (!knowledge) throw fail('knowledge_unavailable', 'The taskflow knowledge store is not available')
  const room = caller.room.id
  const db = knowledge.db

  // 意图来源集合 = 本群全部 insights（重复调用时来源已被消费，仍须能命中幂等）
  let intentRows = db.prepare('SELECT plan_id AS id,title,text,at FROM insights WHERE room=? ORDER BY at,plan_id').all(room)

  // sourceIds：与意图集合取交集；出现不在本群的 id → cross_room_source_unsupported（§4.2/§4.3）
  if (Array.isArray(args.sourceIds) && args.sourceIds.length) {
    const ids = args.sourceIds.map(String)
    for (const id of ids) {
      const owner = db.prepare('SELECT room FROM insights WHERE plan_id=?').get(id)
      if (!owner || owner.room !== room) {
        throw fail('cross_room_source_unsupported',
          '跨群心得合并需要改 reviewEvidence，本次不支持；请在本群内合并，跨群请用检索')
      }
    }
    const wanted = new Set(ids)
    intentRows = intentRows.filter(row => wanted.has(row.id))
  }

  const topic = String(args.topic ?? '').trim()
  if (topic) intentRows = intentRows.filter(row =>
    score(topic, row.title) >= 0.30 || score(topic, row.text) >= 0.30)
  const intentIds = intentRows.map(row => row.id).sort()

  // 幂等：已有 draft 的 candidate_sources 集合与本次意图集合完全一致
  const drafts = db.prepare("SELECT id FROM candidates WHERE room=? AND tier='normal' AND status='draft'").all(room)
  for (const draft of drafts) {
    const sources = db.prepare('SELECT source_id FROM candidate_sources WHERE candidate_id=? ORDER BY source_id')
      .all(draft.id).map(row => row.source_id)
    if (sameSet(sources, intentIds)) {
      return { candidate_id: draft.id, tier: 'normal', status: 'draft', sources, idempotent: true }
    }
  }

  // 冲突：任一来源已被其他 candidate 消费 → source_already_merged + 占用者 id（不吞错、不覆盖）
  for (const id of intentIds) {
    const occupied = db.prepare("SELECT candidate_id FROM candidate_sources WHERE room=? AND tier='normal' AND source_id=?")
      .get(room, id)
    if (occupied) throw fail('source_already_merged', `source ${id} 已被候选 ${occupied.candidate_id} 占用`)
  }

  // 4) Union-Find 最大连通簇；<10 insufficient_insights；>10 medoid 最近 10 条
  const clusters = clusterRows(intentRows)
  const largest = clusters.sort((a, b) => b.length - a.length)[0] ?? []
  if (largest.length < 10) {
    throw fail('insufficient_insights', `found=${largest.length}, need=10`, { found: largest.length, need: 10 })
  }
  const chosen = largest.length > 10 ? nearestToMedoid(largest, 10) : largest
  const seed = chosen[0]

  // 5) 0.92 去重（与 promote:335-336 同源）
  const approved = db.prepare("SELECT title,text FROM candidates WHERE room=? AND tier='normal' AND status='approved'").all(room)
  if (approved.some(row => similar(seed, row, 0.92))) {
    throw fail('duplicate_skill', '同主题技能已存在（similar>=0.92）')
  }

  // 6) 单事务写：candidates 只给 (id,room,tier,title,status,at)，text 默认 ''、双审列 NULL
  const candidateId = randomUUID()
  const sources = chosen.map(row => row.id).sort()
  knowledge.write(() => {
    db.prepare('INSERT INTO candidates(id,room,tier,title,status,at) VALUES(?,?,?,?,?,?)')
      .run(candidateId, room, 'normal', seed.title, 'draft', knowledge.clock())
    const insert = db.prepare('INSERT INTO candidate_sources(room,tier,source_id,candidate_id) VALUES(?,?,?,?)')
    for (const sourceId of sources) insert.run(room, 'normal', sourceId, candidateId)
  })
  return { candidate_id: candidateId, tier: 'normal', status: 'draft', sources, idempotent: false }
}

// ---------------------------------------------------------------------------
// §6.2 只读投影：工具与 HTTP 端点共用同一个 projectIndexState（零漂移 = 同一函数）。
// fix(Chief 40bb86fd)：投影只吃「显式授权集」rooms:[{id,tier}]，由工具路径从
// exec.agent→scope() 的 caller 经 authorizedRooms() 派生；tier 用 scheduler.botLevel()
// 现算，scope:'all' 仅扩展到 caller 任 admin 的群，成员静默降级 room。
// 端点核实：DSB index.js:59 inject 无 webServer（全树 ctx.webServer 仅命中本文件守卫），
// GUI 认证层 401 拦在路由之前 → 无 exec.agent、不在认证层之后，projectIndexState
// 不构造授权集，降成不含群标识/分档/候选的聚合计数（identity_unavailable）。
// ---------------------------------------------------------------------------
export function collectMergeCandidates(knowledge, rooms) {
  const out = []
  for (const room of rooms) {
    const rows = knowledge.db.prepare(`SELECT plan_id AS id,title,text FROM insights i WHERE room=?
      AND NOT EXISTS (SELECT 1 FROM candidate_sources s WHERE s.room=i.room AND s.tier='normal' AND s.source_id=i.plan_id)
      ORDER BY i.at,i.plan_id`).all(room.id)
    for (const cluster of clusterRows(rows)) {
      // DESIGN §6.2 契约 {cluster_size, topic}；绝不回带 room 字段（4b 外群群标识泄漏源）
      out.push({ cluster_size: cluster.length, topic: cluster[0].title })
    }
  }
  return out
}

const TIER_VALUES = ['normal', 'excellent', 'premium']
const safeTier = (roomId, botId, scheduler) => {
  try {
    const tier = scheduler?.botLevel?.(roomId, botId)?.tier
    return TIER_VALUES.includes(tier) ? tier : 'normal'
  } catch { return 'normal' }
}

/** 由 caller 身份派生显式授权集 rooms:[{id,tier}]；scope:'all' 仅限 admin 群。 */
export function authorizedRooms({ state, caller, scheduler, scope = 'room' } = {}) {
  const botId = caller?.botId
  const ownRoom = caller?.room
  if (!botId || !ownRoom?.id) return { rooms: [], applied: scope }
  const allRooms = typeof state?.rooms === 'function' ? state.rooms() : []
  const adminRooms = allRooms.filter(room => room?.admin === botId)
  let applied = ['room', 'shared', 'all'].includes(scope) ? scope : 'room'
  let base = [ownRoom]
  if (applied === 'all') {
    if (adminRooms.length) base = adminRooms
    else { applied = 'room'; base = [ownRoom] }
  }
  const seen = new Set()
  const rooms = []
  for (const room of base) {
    if (!room?.id || seen.has(room.id)) continue
    seen.add(room.id)
    rooms.push({ id: room.id, tier: safeTier(room.id, botId, scheduler) })
  }
  return { rooms, applied }
}

/** 端点聚合计数：单一全局总数，不含群标识/分档/候选；不遍历 state.rooms()。 */
function aggregateCounts(knowledge, scope) {
  let skills = 0
  try { skills = knowledge.db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status='approved'").get().n } catch { skills = 0 }
  return {
    ok: true, scope, scope_applied: 'aggregate', aggregate: true,
    degraded: 'identity_unavailable',
    counts: { skills, byTier: {}, byLifecycle: {}, byTag: {} },
    merge_candidates: [],
  }
}

export function projectIndexState(view = {}) {
  const { knowledge, scope = 'room', caller = null, rooms = null, scope_applied = null } = view
  const empty = { skills: 0, byTier: {}, byLifecycle: {}, byTag: {} }
  if (!knowledge) {
    return { ok: false, scope, counts: empty, merge_candidates: [], degraded: 'knowledge_unavailable' }
  }
  // 端点/无身份：拿不到 caller+rooms 显式授权集就降成聚合计数，绝不遍历全部群
  if (!caller || !Array.isArray(rooms) || rooms.length === 0) return aggregateCounts(knowledge, scope)
  const seen = new Set()
  const rows = []
  for (const room of rooms) {
    let pool = []
    try { pool = knowledge.availableSkills(room.id, room.tier) } catch { pool = [] }
    for (const row of pool) {
      if (scope === 'shared' && row.shared !== true) continue
      if (seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
    }
  }
  const counts = { skills: rows.length, byTier: {}, byLifecycle: {}, byTag: {} }
  for (const row of rows) {
    counts.byTier[row.tier] = (counts.byTier[row.tier] ?? 0) + 1
    counts.byLifecycle[row.lifecycle] = (counts.byLifecycle[row.lifecycle] ?? 0) + 1
    for (const tag of (row.tags ?? [])) counts.byTag[tag] = (counts.byTag[tag] ?? 0) + 1
  }
  return {
    ok: true, scope, scope_applied: scope_applied ?? scope, counts,
    merge_candidates: collectMergeCandidates(knowledge, rooms),
  }
}

// ---------------------------------------------------------------------------
// 工具层：形状对齐 buildToolDefinitions（tools.js:257-274）
// ---------------------------------------------------------------------------
const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}
const GROUP = { type: 'string', description: 'Exact group chat name; optional inside that group' }

export const SKILL_INDEX_TOOL_SPECS = [
  {
    name: 'skill_index_search',
    leader: false,
    write: false,
    description: '按功能分类/关键词/scope 检索已审核技能（只读）。成员 scope:all 静默降级 room。',
    parameters: {
      query: { type: 'string', description: '关键词；可空（空条件浏览）' },
      tags: { type: 'array', items: { type: 'string' }, description: '分类标签，父类自动补齐' },
      scope: { type: 'string', enum: ['room', 'shared', 'all'] },
      limit: { type: 'integer', description: '默认 50，上限 200' },
      cursor: { type: 'string', description: '分页游标（stable sort key + id）' },
      group: GROUP,
    },
    core: indexSearch,
  },
  {
    name: 'skill_index_status',
    leader: false,
    write: false,
    description: '只读投影：索引数量、分类分布、待合并候选。与只读端点共用 projectIndexState。',
    parameters: { scope: { type: 'string', enum: ['room', 'shared', 'all'] }, group: GROUP },
    projection: true,
  },
  {
    name: 'skill_index_classify',
    leader: false,
    write: false,
    description: '对指定技能给出功能分类建议（只产建议，不写库；人工改判走 consolidate）。',
    parameters: { id: { type: 'string', required: true, description: '技能/candidate id' }, group: GROUP },
    core: indexClassify,
  },
  {
    name: 'skill_index_merge',
    leader: true,
    write: true,
    description: '主理用：把同群同主题心得合并为一个 draft（单群；幂等；只产 draft 不写正文）。',
    parameters: {
      topic: { type: 'string', description: '主题软过滤（score>=0.30）' },
      sourceIds: { type: 'array', items: { type: 'string' }, description: '指定来源 id（须全部属于本群）' },
      group: GROUP,
    },
    core: indexMerge,
  },
]

const errorBody = error => {
  if (error instanceof SchedulerError) {
    const body = { success: false, error: error.code, message: error.message }
    if (error.details) body.details = error.details
    return body
  }
  return { success: false, error: 'taskflow_error', message: String(error?.message ?? error) }
}

/**
 * define 可注入（fixture 用透传 define 直接测 execute）。
 * start(name) 返回真实 TaskflowService；scope(exec,...) 是唯一身份来源。
 * viewFor(scope) 保留为注入兼容参数，但 fix(40bb86fd) 后 status 投影不再信任无身份
 * 注入投影：改由 caller 派生显式授权集 rooms:[{id,tier}]，tier 用 scheduler.botLevel() 现算。
 * 端点/Harness 注入的 viewFor 不携带 exec.agent，继续用它会把外群/越级档位泄给普通成员。
 */
export function buildSkillIndexTools(define = defineTool, { start, state, rt } = {}) {
  return SKILL_INDEX_TOOL_SPECS.map(spec => define({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: OUTPUT,
    async execute(args = {}, exec) {
      try {
        const readOnly = typeof rt?.readOnly === 'function' && rt.readOnly() !== undefined
        // 只读宿主：merge 不在 READS，start 前短路，确保返回 read_only_host 而非裸错误
        if (spec.write && readOnly) throw fail('read_only_host', 'Merge is unavailable on a read-only host')
        const active = await start(spec.name)
        if (!active) throw fail('knowledge_unavailable', 'The taskflow ledger is not available')
        // 身份门：exec.agent 推导，禁止 botId/roomId 参数
        const caller = active.scope(exec, args.group, { leader: spec.leader === true })
        if (spec.projection) {
          const scope = ['room', 'shared', 'all'].includes(args.scope) ? args.scope : 'room'
          const { rooms, applied } = authorizedRooms({ state, caller, scheduler: active.scheduler, scope })
          const value = projectIndexState({
            knowledge: active.knowledge, scheduler: active.scheduler, state, caller, rooms,
            scope, scope_applied: applied,
          })
          return JSON.stringify({ success: true, ...value }, null, 2)
        }
        const view = {
          knowledge: active.knowledge,
          scheduler: active.scheduler,
          state,
          caller,
          readOnly,
          scope: args.scope,
          modelClassify: undefined,
        }
        if (!view.knowledge) throw fail('knowledge_unavailable', 'The taskflow knowledge store is not available')
        let value = spec.core(view, args)
        if (value && typeof value.then === 'function') value = await value
        return JSON.stringify({ success: true, ...value }, null, 2)
      } catch (error) {
        return JSON.stringify(errorBody(error), null, 2)
      }
    },
  }))
}

// ---------------------------------------------------------------------------
// §6.4 只读端点守卫（范式复制 compaction-plugin/src/state.js:17-42）
// ---------------------------------------------------------------------------
export const isLoopbackAddress = address => {
  const value = String(address ?? '')
  return value === '::1' || value === '::ffff:127.0.0.1' || value.startsWith('::ffff:127.')
    || value.startsWith('127.')
}
export const isProxiedRequest = req => Boolean(
  req?.headers?.['cf-connecting-ip'] || req?.headers?.['x-forwarded-for'])
export const isLoopbackRequest = req => {
  if (isProxiedRequest(req)) return false
  const remote = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? req?.remoteAddress
  if (!isLoopbackAddress(remote)) return false
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const hostPart = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  if (!(hostPart === 'localhost' || hostPart === '[::1]' || hostPart.startsWith('127.'))) return false
  if (req?.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req?.headers?.origin
  if (origin) {
    try {
      const originHost = new URL(origin).hostname.toLowerCase()
      if (!(originHost === 'localhost' || originHost === '::1' || originHost.startsWith('127.'))) return false
    } catch { return false }
  }
  return true
}

const writeJson = (res, status, payload, headers = {}) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

/** getState(scope) 返回 projectIndexState 的结果；不解析请求体。 */
export function createStateRoutes(getState) {
  return [{
    kind: 'exact',
    path: STATE_ROUTE,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'loopback_only' })
        return
      }
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        writeJson(res, 405, { ok: false, error: 'method_not_allowed' }, { allow: 'GET' })
        return
      }
      let scope = 'room'
      try { scope = new URL(req.url ?? STATE_ROUTE, 'http://localhost').searchParams.get('scope') || 'room' } catch { /* keep room */ }
      if (!['room', 'shared', 'all'].includes(scope)) scope = 'room'
      Promise.resolve()
        .then(() => getState(scope))
        .then(state => writeJson(res, 200, state))
        .catch(() => writeJson(res, 200, {
          ok: false, scope, counts: { skills: 0, byTier: {}, byLifecycle: {}, byTag: {} },
          merge_candidates: [], degraded: 'knowledge_unavailable',
        }))
    },
  }]
}

// ---------------------------------------------------------------------------
// install(rt, start, state)：与 knowledge-runtime.js:68 同形。
// 端点守卫式注册（DSB index.js inject 无 webServer，不可达时如实返回 inert）。
// ---------------------------------------------------------------------------
export function install(rt, start, state) {
  // 端点核实（fix 40bb86fd）：DSB index.js:59 inject 无 webServer（全树 ctx.webServer
  // 仅命中本文件守卫），GUI 认证层 401 拦在路由之前 → 端点无 exec.agent、不在认证层
  // 之后。故端点 view 不构造授权集，projectIndexState 降成聚合计数（零群标识）。
  const viewFor = async (scope = 'room') => {
    let active = null
    try { active = await start('skill_index_status') } catch { active = null }
    return {
      knowledge: active?.knowledge ?? null,
      scheduler: active?.scheduler ?? null,
      state,
      scope,
      caller: null,
      rooms: null,
    }
  }
  const project = async scope => projectIndexState(await viewFor(scope))

  const tools = buildSkillIndexTools(defineTool, {
    start,
    state,
    rt,
    viewFor: project,
  })
  const added = []
  for (const tool of tools) {
    if (!rt.teamTools.some(existing => existing.name === tool.name)) {
      rt.teamTools.push(tool)
      added.push(tool.name)
    }
  }

  let endpoint = 'inert'
  // Optional services must be resolved through get(): Cordis throws on an
  // uninjected property getter before optional chaining can test its value.
  const webServer = typeof rt.ctx?.get === 'function' ? rt.ctx.get('webServer') : undefined
  if (webServer && typeof webServer.register === 'function' && typeof rt.ctx?.effect === 'function') {
    try {
      const routes = createStateRoutes(project)
      rt.ctx.effect(() => {
        const disposers = routes.map(route => webServer.register(route))
        return () => { for (const dispose of disposers) { try { dispose?.() } catch { /* ignore */ } } }
      }, 'ds-bot: skill-index state')
      endpoint = 'mounted'
    } catch {
      endpoint = 'inert'
    }
  }
  return { service: SERVICE_NAME, tools: added, endpoint }
}

export default { install, buildSkillIndexTools, createStateRoutes, projectIndexState, authorizedRooms, collectMergeCandidates, indexSearch, indexClassify, indexMerge }
