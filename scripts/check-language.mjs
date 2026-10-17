#!/usr/bin/env node
/**
 * Language guard: system files must be English.
 *
 * Indonesian is allowed only in `data/` (user content: thread titles, conversations,
 * agent SOUL.md/AGENT.md) and in the maintainer's briefs. Everything that belongs to
 * the system itself — code, comments, UI labels, API messages, model prompts, docs —
 * is English.
 *
 * Usage: node scripts/check-language.mjs [--json]
 * Escape hatch: put `lang-allow` in a comment on the line to skip it.
 */
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Where system text lives. Anything not listed here is not checked. */
const TARGETS = [
  "packages/server/src",
  "packages/server/scripts",
  "packages/web/src",
  "packages/web/scripts",
  "packages/web/public",
  "packages/web/index.html",
  "packages/web/vite.config.ts",
  "scripts",
  "docs",
  "README.md",
  ".env.example",
];

const SKIP_DIRS = new Set(["node_modules", "data", "dist", ".git", ".vite", "assets"]);
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".wasm",
]);
/** Generated artifacts: their content is derived from files that are checked themselves. */
const SKIP_FILES = new Set(["manifest.json"]);

/**
 * Indonesian markers. Function words plus the words that actually appear in this
 * project's text.
 */
const MARKERS = [
  "ada", "adalah", "agar", "akan", "aktif", "anda", "atau", "bagi", "bahasa", "baik", "banyak",
  "baru", "belum", "benar", "berkas", "berhasil", "besar", "bisa", "buat", "buka", "bukan",
  "cari", "cepat", "dalam", "dan", "dari", "dengan", "di", "digunakan", "dulu", "gagal", "grup",
  "harus", "hasil", "hanya", "hidup", "hilang", "ini", "isi", "itu", "jadi", "jam", "jalan",
  "jalankan", "jawab", "juga", "kalau", "kamu", "karena", "ke", "kecil", "kembali", "kirim",
  "klaim", "koneksi", "kosong", "kurang", "lama", "lambat", "lebih", "lihat", "masih", "mati",
  "menambah", "menambahkan", "menggunakan", "mengubah", "menghapus", "mengirim", "menjalankan",
  "menyambung", "menyimpan", "milik", "mudah", "mulai", "mungkin", "nama", "namun", "nanti",
  "nonaktif", "panggil", "pasti", "penuh", "perlu", "pesan", "pilih", "punya", "saja", "salah",
  "sama", "sangat", "sebuah", "sedang", "sedikit", "sekarang", "selalu", "selesai", "semua",
  "sendiri", "seperti", "sesi", "setiap", "simpan", "sulit", "supaya", "tambah", "tanpa", "tampil",
  "tetap", "tidak", "tolak", "tunggu", "tutup", "ubah", "ukuran", "ulang", "untuk", "wajib", "yang",
];

const MARKER_PATTERN = new RegExp(`\\b(${MARKERS.join("|")})\\b`, "gi");

/**
 * Neutralise escape sequences before matching, so a word that follows `\n` inside a
 * string literal is still seen as a word. Without this, `"\n\nKamu "` is missed
 * because the `n` before it counts as a word character.
 */
function probe(line) {
  return line.replace(/\\[nrtvfb0"'\\]/g, " ");
}

async function collect(path) {
  const absolute = resolve(ROOT, path);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return [absolute];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    if (SKIP_FILES.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await collect(`${path}/${entry.name}`)));
      continue;
    }
    const dot = entry.name.lastIndexOf(".");
    const extension = dot === -1 ? "" : entry.name.slice(dot).toLowerCase();
    if (SKIP_EXTENSIONS.has(extension)) continue;
    files.push(resolve(ROOT, path, entry.name));
  }
  return files;
}

const findings = [];
for (const target of TARGETS) {
  for (const file of await collect(target)) {
    if (file.endsWith("check-language.mjs")) continue;
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const [index, line] of text.split("\n").entries()) {
      if (line.includes("lang-allow")) continue;
      const matches = [...probe(line).matchAll(MARKER_PATTERN)].map((match) => match[1].toLowerCase());
      if (matches.length === 0) continue;
      findings.push({
        file: relative(ROOT, file),
        line: index + 1,
        words: [...new Set(matches)],
        text: line.trim().slice(0, 110),
      });
    }
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ findings, files: new Set(findings.map((f) => f.file)).size }, null, 2));
} else if (findings.length === 0) {
  console.log("check-language: clean — no Indonesian markers in system files");
} else {
  const files = [...new Set(findings.map((finding) => finding.file))].sort();
  console.log(`check-language: ${findings.length} findings in ${files.length} files\n`);
  for (const file of files) {
    const rows = findings.filter((finding) => finding.file === file);
    console.log(`${file} (${rows.length})`);
    for (const row of rows.slice(0, 4)) {
      console.log(`  ${row.line}: [${row.words.join(",")}] ${row.text}`);
    }
    if (rows.length > 4) console.log(`  … ${rows.length - 4} more`);
  }
  console.log(`\nAllowed: data/ (user content) and lang-allow comments.`);
}

process.exit(findings.length === 0 ? 0 : 1);
