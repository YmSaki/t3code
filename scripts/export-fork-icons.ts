#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import sharp from "sharp";
import {
  FORK_BRAND_COLORS,
  FORK_ICON_DIRECTORIES,
  FORK_MOBILE_ICON_PATHS,
  resolveWebIconOverrides,
} from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

class ForkIconExportError extends Schema.TaggedError<ForkIconExportError>()("ForkIconExportError", {
  file: Schema.String,
  cause: Schema.Defect(),
}) {}

const exportIcons = Effect.fn("forkIcons.export")(function* (check: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const source = yield* fs.readFileString(path.join(root, "assets/fork/icon.svg"));
  const write = Effect.fn("forkIcons.write")(function* (relative: string, bytes: Uint8Array) {
    const file = path.join(root, relative);
    if (check) {
      const current = yield* fs.readFile(file);
      if (!Buffer.from(current).equals(Buffer.from(bytes))) {
        return yield* new ForkIconExportError({ file, cause: "Run vp run icons:export" });
      }
    } else {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFile(file, bytes);
    }
  });
  const compositeCentered = (size: number, innerSize: number, inputSvg: Buffer, file: string) =>
    Effect.tryPromise({
      try: async () => {
        const offset = Math.round((size - innerSize) / 2);
        return sharp({
          create: { width: size, height: size, channels: 4, background: "#00000000" },
        })
          .composite([
            {
              input: await sharp(inputSvg).resize(innerSize, innerSize).png().toBuffer(),
              left: offset,
              top: offset,
            },
          ])
          .png()
          .toBuffer();
      },
      catch: (cause) => new ForkIconExportError({ file, cause }),
    });

  for (const brand of ["production", "nightly", "development"] as const) {
    const background = FORK_BRAND_COLORS[brand];
    const svgText = source.replace("#123a3b", background);
    const svg = Buffer.from(svgText);
    const fullBleedSvg = Buffer.from(svgText.replace('rx="28"', 'rx="0"'));
    const glyphSvg = Buffer.from(svgText.replace(/<rect[^>]*\/>\s*/, ""));
    const render = (size: number, inputSvg: Buffer = svg) =>
      Effect.tryPromise({
        try: () => sharp(inputSvg).resize(size, size).png().toBuffer(),
        catch: (cause) => new ForkIconExportError({ file: "assets/fork/icon.svg", cause }),
      });
    const directory = FORK_ICON_DIRECTORIES[brand];
    for (const [file, size] of [
      ["icon-1024.png", 1024],
      ["icon-512x512.png", 512],
      ["icon-192x192.png", 192],
      ["apple-touch-icon.png", 180],
      ["favicon-32x32.png", 32],
      ["favicon-16x16.png", 16],
    ] as const) {
      yield* write(`${directory}/${file}`, yield* render(size));
    }
    yield* write(`${directory}/ios-1024.png`, yield* render(1024, fullBleedSvg));
    yield* write(
      `${directory}/mac-1024.png`,
      yield* compositeCentered(1024, 824, svg, `${directory}/mac-1024.png`),
    );
    yield* write(
      `${directory}/android-foreground-1024.png`,
      yield* compositeCentered(1024, 676, glyphSvg, `${directory}/android-foreground-1024.png`),
    );
    yield* write(
      `${directory}/android-splash-1024.png`,
      yield* compositeCentered(1024, 636, svg, `${directory}/android-splash-1024.png`),
    );
    const renditions = yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
      render(size).pipe(Effect.map((contents) => ({ size, contents }))),
    );
    yield* write(`${directory}/icon.ico`, encodePngIco(renditions));
    yield* write(
      `${directory}/favicon.ico`,
      encodePngIco(renditions.filter(({ size }) => size <= 48)),
    );
  }
  const whiteGlyphSvg = Buffer.from(
    source.replace(/<rect[^>]*\/>\s*/, "").replace(/fill="#(?:ed795e|f8f5eb)"/g, 'fill="#ffffff"'),
  );
  yield* write(
    FORK_MOBILE_ICON_PATHS.monochrome,
    yield* compositeCentered(1024, 676, whiteGlyphSvg, FORK_MOBILE_ICON_PATHS.monochrome),
  );
  yield* write(
    FORK_MOBILE_ICON_PATHS.notification,
    yield* compositeCentered(96, 76, whiteGlyphSvg, FORK_MOBILE_ICON_PATHS.notification),
  );
  for (const override of resolveWebIconOverrides("development", "apps/web/public")) {
    yield* write(
      override.targetRelativePath,
      yield* fs.readFile(path.join(root, override.sourceRelativePath)),
    );
  }
  yield* Console.log(
    check
      ? "T3CodeJP icons match their SVG source."
      : "Exported T3CodeJP desktop, mobile, and web icons.",
  );
});

Command.run(
  Command.make(
    "export-fork-icons",
    {
      check: Flag.Boolean("check").pipe(Flag.withDefault(false)),
    },
    ({ check }) => exportIcons(check),
  ),
  { version: "0.0.0" },
).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
