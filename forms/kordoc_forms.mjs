// 서무비서 한글 서식 작성 — kordoc(https://github.com/chrisryugj/kordoc, MIT) 사용
//   generate : 초안 항목 → 공문 '보고서' 서식 HWPX(표 + □ 항목)
//   gian     : kordoc 내장 표준 간이기안문·일반기안문 누름틀 채우기
//   fill     : 사용자·기관 서식(.hwpx)의 라벨 칸·누름틀에 값 채우기(원본 서식 보존)
// 입력은 모두 JSON. 결과는 {buffer, report}.
import { markdownToHwpx, fillForm, fillHwpx, extractClickHereFields, extractFormFields, parse } from "kordoc"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const MAX_FORM = 5 * 1024 * 1024
const KO = "가나다라마바사아자차카타파하"

export class FormError extends Error { constructor(msg, status = 400) { super(msg); this.status = status } }

const str = (v, n = 4000) => String(v ?? "").replace(/\r/g, "").slice(0, n)
const cell = (v) => str(v, 400).replace(/\|/g, "｜").replace(/\s*\n\s*/g, " ").trim()
// 문단 안에서 마크다운으로 해석될 수 있는 앞머리를 무력화
const para = (v) => str(v, 1000).trim().replace(/^([#>*+\-]|\d+[.)])\s/, "\\$1 ")

function items(text) {
  return str(text).split("\n").map((x) => x.trim().replace(/^([-·•○◦*]|\d+[.)]|[가-하][.)])\s*/, "")).filter(Boolean).slice(0, 40)
}

/** 초안 항목 → kordoc 공문 마크다운 */
export function draftMarkdown({ title, rows = [], closing = [] }) {
  // 형식이 틀린 요청(목록 자리에 다른 값)도 빈 목록으로 받아 500 대신 빈 칸으로 만든다
  if (!Array.isArray(rows)) rows = []
  if (!Array.isArray(closing)) closing = []
  rows = rows.filter((r) => r && typeof r === "object")
  const t = cell(title) || "보고서"
  const one = rows.filter((r) => !r.multi && str(r.value).trim())
  const multi = rows.filter((r) => r.multi && str(r.value).trim())
  const out = [`# ${t}`, ""]
  if (one.length) {
    out.push("| 구분 | 내용 |", "| --- | --- |")
    for (const r of one.slice(0, 30)) out.push(`| ${cell(r.label)} | ${cell(r.value)} |`)
    out.push("")
  }
  multi.slice(0, 12).forEach((r, i) => {
    out.push(`${i + 1}. ${cell(r.label)}`)
    items(r.value).forEach((x, j) => out.push(`  ${KO[j % KO.length]}. ${para(x)}`))
    out.push("")
  })
  for (const c of closing.slice(0, 6)) if (str(c).trim()) out.push(para(c), "")
  return out.join("\n")
}

export async function generate(body) {
  const md = draftMarkdown(body || {})
  const buf = await markdownToHwpx(md, { gongmun: { preset: "보고서" } })
  return { buffer: Buffer.from(buf), report: { generator: "kordoc", preset: "보고서" } }
}

const TEMPLATES = { "gian": "일반기안문_서식.hwpx", "gian-simple": "간이기안문_서식.hwpx" }
async function builtinTemplate(id) {
  const f = TEMPLATES[id]
  if (!f) throw new FormError("기안문 서식은 gian(일반) 또는 gian-simple(간이)입니다.")
  // kordoc 패키지에 들어 있는 표준 서식(dist/ 옆 templates/) — 공개 API 가 없어 경로로 읽는다
  const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("kordoc"))))
  return readFile(path.join(pkgDir, "templates", f))
}

function cleanValues(values) {
  const out = {}
  for (const [k, v] of Object.entries(values || {}).slice(0, 200)) {
    const key = str(k, 40).trim()
    if (key) out[key] = str(v, 4000)
  }
  return out
}

export async function gian(body) {
  const id = body?.template === "gian" ? "gian" : "gian-simple"
  const tpl = await builtinTemplate(id)
  const r = await fillHwpx(tpl, cleanValues(body?.values))
  return { buffer: Buffer.from(r.buffer), report: { template: id, filled: (r.filled || []).length, unmatched: r.unmatched || [] } }
}

function decodeForm(b64) {
  if (typeof b64 !== "string" || !b64) throw new FormError("서식 파일(.hwpx)이 필요합니다.")
  const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ""), "base64")
  if (buf.length > MAX_FORM) throw new FormError("서식 파일은 5MB까지 올릴 수 있습니다.", 413)
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new FormError("한글 .hwpx 서식만 지원합니다. .hwp 는 한글에서 .hwpx 로 저장해 올려 주세요.")
  return buf
}

/** 서식의 채울 수 있는 칸(라벨·누름틀) */
export async function inspect(body) {
  const buf = decodeForm(body?.form)
  const click = await extractClickHereFields(buf).catch(() => [])
  let labels = []
  try {
    const p = await parse(buf)
    if (p.success) labels = (extractFormFields(p.blocks).fields || []).map((f) => f.label).filter(Boolean)
  } catch (e) { /* 표가 없는 서식 */ }
  return { report: { clickHere: (click || []).map((c) => c.name).filter(Boolean), labels: [...new Set(labels)].slice(0, 200) } }
}

/** 사용자·기관 서식에 채우기 — 누름틀 이름으로 먼저, 남은 값은 표의 라벨 칸으로 */
export async function fill(body) {
  let buf = decodeForm(body?.form)
  const values = cleanValues(body?.values)
  const filledKeys = new Set()
  const click = await extractClickHereFields(buf).catch(() => [])
  if (click && click.length) {
    const names = new Set(click.map((c) => c.name))
    const sub = Object.fromEntries(Object.entries(values).filter(([k]) => names.has(k)))
    if (Object.keys(sub).length) {
      const r = await fillHwpx(buf, sub)
      buf = Buffer.from(r.buffer)
      for (const f of r.filled || []) filledKeys.add(f.key || f.name || f.label)
    }
  }
  const rest = Object.fromEntries(Object.entries(values).filter(([k]) => !filledKeys.has(k)))
  if (Object.keys(rest).length) {
    try {
      const r = await fillForm(buf, rest, "hwpx-preserve")
      if (r.output) buf = Buffer.from(r.output)
      for (const f of r.fill?.filled || []) filledKeys.add(f.key || f.label)
    } catch (e) { /* 표 라벨이 없는 서식이면 누름틀 결과만 */ }
  }
  return { buffer: buf, report: { filled: [...filledKeys] } }
}

export async function run(action, body) {
  if (action === "status") return { report: { available: true, engine: "kordoc" } }
  if (action === "generate") return generate(body)
  if (action === "gian") return gian(body)
  if (action === "inspect") return inspect(body)
  if (action === "fill") return fill(body)
  throw new FormError("알 수 없는 요청입니다.", 404)
}
