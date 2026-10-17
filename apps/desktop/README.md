# Shell desktop (Tauri v2) — BELUM DIVERIFIKASI

Folder ini menyiapkan bungkus desktop untuk aplikasi yang sudah jalan di browser.
**Belum dikompilasi sama sekali**: mesin ini belum punya Rust, dan `cargo build` pertama
butuh ~1,5 GB unduhan + 5–15 menit.

## Cara membangun

```bash
# 1. toolchain Rust + paket sistem (Arch)
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg

# 2. UI harus sudah di-build sekali (shell desktop menyajikan hasil build lewat server)
npm run build

# 3. jalankan
cd apps/desktop
npm install
npm run dev      # cargo tauri dev
npm run build    # cargo tauri build  -> .deb / AppImage
```

## Yang dilakukan shell ini (sengaja sesingkat mungkin)

1. Menjalankan server Node (`packages/server/src/index.ts`) sebagai proses anak.
2. Menunggu baris `PI_SERVER_READY {"port":…,"token":…}` di stdout server (maks 20 detik).
3. Membuka jendela webview ke `http://127.0.0.1:<port>` (server yang menyajikan UI + API + WS,
   jadi tidak ada CORS dan tidak ada CSP tambahan).
4. Mematikan proses anak saat jendela ditutup.

## Yang belum ada (jujur)

- Belum ada `tauri-plugin-single-instance`: menjalankan aplikasi dua kali berarti dua server
  memegang `data/app.sqlite` yang sama (pi-durable mengasumsikan satu penulis). Jangan dijalankan
  dobel sebelum plugin ini dipasang.
- Belum ada tray icon, notifikasi native, atau auto-update.
- Distribusi tanpa Node (bundle `node` sebagai resource / Node SEA) belum dikerjakan.
- `main.rs` ditulis hati-hati tapi **belum pernah dikompilasi**; anggap ini rancangan yang bisa jalan,
  bukan hasil yang sudah terbukti.
