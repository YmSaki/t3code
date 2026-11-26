<p align="center">
  <a href="https://github.com/YmSaki/t3code">
    <img src="./assets/fork/icon.svg" width="80" height="80" alt="T3CodeJPのロゴ" />
  </a>
</p>

<h1 align="center">T3CodeJP</h1>

<p align="center">コーディングエージェントをまとめて操作できる、オープンソースのアプリケーション。</p>

<p align="center">
  <a href="https://github.com/YmSaki/t3code/releases"><strong>フォーク版のダウンロード</strong></a> ·
  <a href="./docs/README.md">ドキュメント</a> ·
  <a href="https://github.com/YmSaki/t3code/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/pingdotgg/t3code">
    <img src="./.github/readme/hero.webp" width="100%" alt="上流版T3 Codeの画面例：デスクトップとスマートフォン" />
  </a>
</p>

T3CodeJPは、手元のPCで動くコーディングエージェントを、共通の画面から操作できるアプリケーションです。デスクトップと、サーバーに同梱したWebクライアントから操作できます。

Claude Code、Codex、Cursor、OpenCode、Grok Build、Antigravity、Kiro、Pi、Muse Code、fx、および[ACP対応エージェント](./docs/user/providers-acp.md)に対応しています。PCにインストール・設定済みのエージェントを接続して利用します。

## このフォークについて

T3CodeJPは[pingdotgg/t3code](https://github.com/pingdotgg/t3code)を元にした非公式フォークです。上流の開発者とは独立して保守しています。セルフホストでの複数PC運用、複数リポジトリを束ねる上位プロジェクト（MetaProject）、PMによるワーカーの並列管理、双方向アーティファクト、リポジトリ監視、既存AIセッションの取り込み、稼働カレンダーなどを開発しています。

実装状況や残件は、このフォークの[Issues](https://github.com/YmSaki/t3code/issues)と[Pull requests](https://github.com/YmSaki/t3code/pulls)を確認してください。画面やサービスの一部は開発・検証中です。

フォーク版の配布物は、このリポジトリの[Releases](https://github.com/YmSaki/t3code/releases)から入手できます。目的の版がまだ公開されていない場合は、[ソースからの開発](#ソースからの開発)を参照してください。

## 主な機能

- **契約済みのエージェントを利用。** T3CodeJPはトークンを再販売せず、すでにログインしているエージェントを操作します。
- **複数のエージェントを一か所で管理。** スレッドの途中でモデルを切り替えたり、ClaudeからCodexへ作業を委譲したりできます。
- **デスクトップ・Web・スマートフォンに対応。** 同じサーバーに接続すると、各クライアントから同じスレッドを確認できます。フォーク版モバイルアプリの独自配布は準備中です。
- **リモート操作。** 別のPC上でエージェントを動かし、LAN、Tailscale、[T3 Connect](./docs/user/remote-access.md)経由で接続できます。
- **Git操作を統合。** スレッドごとにworktreeを分けられます。差分の確認からコミット、プッシュ、PR作成まで操作できます。
- **パフォーマンスを重視。** 描画や通信の性能を計測し、フレーム落ちも不具合として扱っています。
- **オープンソース。** MITライセンスで公開されており、フォークして変更できます。

## インストール

### デスクトップアプリ

macOS・Windows・Linux向けのフォーク版は[T3CodeJPのReleases](https://github.com/YmSaki/t3code/releases)から入手してください。StableとNightlyはリリース名で区別できます。インストール・更新の詳細は[インストールガイド](./docs/user/install.md)を参照してください。

### コマンドライン

Releasesから目的の版の`install.sh`または`install.ps1`をダウンロードして実行してください。これらはフォーク版のCLIアーカイブを検証して導入します。インストール後は`t3`でサーバーと同梱Webクライアントを起動できます。

### スマートフォン・ホスト版Web

フォーク版のモバイル配布は[#50](https://github.com/YmSaki/t3code/issues/50)、ホスト版Webは[#49](https://github.com/YmSaki/t3code/issues/49)で準備中です。上流のストア版や`app.t3.codes`には、このフォーク独自の変更は含まれません。

### エージェントへのログイン

T3CodeJPを使うには、少なくとも1つのエージェントをインストールし、ログインしておく必要があります。たとえば、[Claude Code](https://claude.com/product/claude-code)では`claude auth login`、[Codex CLI](https://developers.openai.com/codex/cli)では`codex login`を実行します。

エージェントごとの設定は[プロバイダーのセットアップ](./docs/user/install.md#providers)を参照してください。Nightly版、AppImage、WSL、NixOSについては[インストールガイド](./docs/user/install.md)で説明しています。

## ソースからの開発

[Vite+](https://viteplus.dev/guide/)の`vp`コマンドを使用します。`vp`は`package.json`で指定されたNode.jsのバージョンを用意します。

macOS・Linuxでは次のコマンドでインストールします。

```bash
curl -fsSL https://vite.plus | bash
```

WindowsではPowerShellで実行します。

```powershell
irm https://vite.plus/ps1 | iex
```

リポジトリを取得し、依存パッケージをインストールします。Windowsの長いパスにも対応できるよう、クローン時に`core.longpaths`を有効にしています。

```bash
git clone -c core.longpaths=true https://github.com/YmSaki/t3code.git
cd t3code
vp i
vp run dev --home-dir ./.t3
```

起動ログに表示されるペアリングURLを開いてください。初回接続では、トークンを含むURLが必要です。上の例では、開発用データをクローン先の`.t3`に保存します。

変更した範囲の品質チェックには、`vp run check:changed`を使用します。開発環境や検証方法の詳細は[開発ガイド](./docs/operations/development.md#first-checkout)を参照してください。

### リポジトリ構成

| パス                      | 役割                                                          |
| ------------------------- | ------------------------------------------------------------- |
| `apps/server`             | WebSocket RPC、エージェント実行、オーケストレーション、永続化 |
| `apps/web`                | React・ViteによるWeb画面                                      |
| `apps/desktop`            | Web画面とサーバーを組み込むElectronアプリ                     |
| `apps/mobile`             | React NativeによるiOS・Androidアプリ                          |
| `packages/contracts`      | クライアント・サーバー間の型とスキーマ                        |
| `packages/client-runtime` | Web・モバイル共通の接続処理と状態管理                         |
| `packages/shared`         | 共通ユーティリティと副作用を持たない処理                      |

設計の全体像は[アーキテクチャ概要](./docs/internals/overview.md)、セルフホストの運用雛形は[セルフホストガイド](./packaging/selfhost/README.md)を参照してください。

## プロジェクトの方針

T3 Codeは、エージェントを使った開発体験をよりよくするために作られました。Codexのデスクトップアプリ、Conductor、Claude Desktop、Cursor Glassなどを参考にしながら、性能、リモート操作、オープンな開発を重視しています。必要に応じてフォークし、自分の求めるツールを作れることも大切にしています。

## ドキュメント

以下の詳細ガイドは主に英語です。

- [インストールと初回起動](./docs/user/install.md)
- [スマートフォン・別PCからのリモートアクセス](./docs/user/remote-access.md)
- [権限モード](./docs/user/permission-modes.md)
- [ソース管理](./docs/user/source-control.md)
- [外部エージェントとのMCP接続](./docs/user/outside-agents.md)
- [よくある質問](./docs/user/faq.md)

[ドキュメント一覧](./docs/README.md)から、すべてのガイドを参照できます。

## コントリビュート

このフォークの不具合や開発課題は[Issues](https://github.com/YmSaki/t3code/issues)で扱っています。

上流への報告や貢献を行う場合は、[CONTRIBUTING.md](./CONTRIBUTING.md)を先に確認してください。上流はレビューできる件数に限りがあるため、範囲を絞った修正を優先し、新機能には事前の議論と承認を求めています。

- 上流への機能提案は[Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas)へ投稿してください。
- 上流コミュニティへの質問は[Discord](https://discord.gg/jn4EGJjrvv)を利用できます。

## ライセンス

[MIT](./LICENSE)
