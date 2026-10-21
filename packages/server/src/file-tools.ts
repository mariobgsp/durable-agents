import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { agentResolver } from "./remember.ts";
import { harnessInstance } from "./harness.ts";
import { renderPdf } from "./pdf.ts";
import {
  ARTIFACT_LIMIT,
  mimeForName,
  saveArtifact,
  artifactName,
  type ArtifactInfo,
} from "./artifacts.ts";

/**
 * Tools that turn an agent's work into a file the owner can download.
 *
 * The file bytes live in data/artifacts; the attached entry carries only metadata. create_file covers text and
 * base64 (any bytes the model can express), create_pdf renders Markdown without a PDF toolchain, and
 * publish_file attaches a file the agent already wrote with write, bash or code mode.
 */

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " kB";
  return bytes + " B";
}

async function attach(
  api: Parameters<ToolRegistration["execute"]>[1],
  context: Context,
  file: ArtifactInfo,
): Promise<string> {
  const conversation = await harnessInstance().conversation(api.conversationId, context);
  if (!conversation) throw new Error("this conversation no longer exists");
  const agentId = await agentResolver()?.(String(api.conversationId));
  const text = "Created " + file.name + " · " + humanBytes(file.bytes);
  await conversation.submit(
    {
      type: "write",
      entry: {
        kind: "chat.file",
        data: {
          text,
          author: agentId ?? null,
          artifacts: [file],
        },
      },
    },
    context,
  );
  return text;
}

function refusal(message: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text", text: message }], isError: true };
}

export const createFileTool = defineTool({
  name: "create_file",
  description:
    "Create a file and attach it to this thread for download. Use it for .md, .txt, .json, .csv, .svg, .html " +
    "or any text file. For binary files pass encoding: base64. The file is saved durably and appears as a " +
    "download card in the conversation.",
  parameters: Type.Object({
    name: Type.String({ description: "File name with extension, for example report.md or data.json." }),
    content: Type.String({ description: "UTF-8 text, or base64 when encoding is base64." }),
    encoding: Type.Optional(
      Type.String({ description: "utf8 (default) or base64 for binary content." }),
    ),
    mimeType: Type.Optional(Type.String({ description: "Optional MIME type; inferred from the extension." })),
  }),
  async execute(args, api, context) {
    try {
      const encoding = args.encoding === "base64" ? "base64" : "utf8";
      const bytes = Buffer.from(args.content, encoding);
      if (bytes.byteLength === 0) return refusal("The file content is empty.");
      if (bytes.byteLength > ARTIFACT_LIMIT) return refusal("The file is larger than 64 MB.");
      const file = await saveArtifact(String(api.conversationId), args.name, args.mimeType ?? "", bytes);
      const text = await attach(api, context, file);
      return {
        output: [{ type: "text", text: text + ". The download card is in this thread." }],
        details: { file },
      };
    } catch (error) {
      return refusal("Could not create the file: " + String(error).slice(0, 300));
    }
  },
});

export const createPdfTool = defineTool({
  name: "create_pdf",
  description:
    "Render Markdown-shaped text as a PDF and attach it to this thread for download. Supports headings, " +
    "paragraphs, bullets and code blocks. It uses the built-in fonts, so non-Latin characters are replaced.",
  parameters: Type.Object({
    content: Type.String({ description: "The document body, in Markdown-shaped plain text." }),
    name: Type.Optional(Type.String({ description: "File name; defaults to document.pdf." })),
    title: Type.Optional(Type.String({ description: "Optional title rendered at the top." })),
  }),
  async execute(args, api, context) {
    try {
      const name = artifactName(args.name ?? "document.pdf").endsWith(".pdf")
        ? artifactName(args.name ?? "document.pdf")
        : artifactName(args.name ?? "document") + ".pdf";
      const bytes = renderPdf({ ...(args.title ? { title: args.title } : {}), body: args.content });
      const file = await saveArtifact(String(api.conversationId), name, "application/pdf", bytes);
      const text = await attach(api, context, file);
      return {
        output: [{ type: "text", text: text + ". The download card is in this thread." }],
        details: { file },
      };
    } catch (error) {
      return refusal("Could not create the PDF: " + String(error).slice(0, 300));
    }
  },
});

export const publishFileTool = defineTool({
  name: "publish_file",
  description:
    "Attach an existing file to this thread for download. Use it after write, bash or code mode created a " +
    "file, including binary files and PDFs from another tool. The path must be inside the agent's own root.",
  parameters: Type.Object({
    path: Type.String({ description: "Path to an existing file, absolute or relative to the agent's cwd." }),
    name: Type.Optional(Type.String({ description: "Download name; defaults to the file's own name." })),
  }),
  async execute(args, api, context) {
    try {
      const agent = await api.agent(context);
      const cwd = agent.cwd ?? process.cwd();
      const absolute = isAbsolute(args.path) ? args.path : resolve(cwd, args.path);
      const info = await stat(absolute);
      if (!info.isFile()) return refusal("That path is not a file.");
      if (info.size <= 0) return refusal("The file is empty.");
      if (info.size > ARTIFACT_LIMIT) return refusal("The file is larger than 64 MB.");
      const bytes = await readFile(absolute);
      const name = args.name ?? basename(absolute);
      const file = await saveArtifact(String(api.conversationId), name, mimeForName(name), bytes);
      const text = await attach(api, context, file);
      return {
        output: [{ type: "text", text: text + ". The download card is in this thread." }],
        details: { file },
      };
    } catch (error) {
      return refusal("Could not publish the file: " + String(error).slice(0, 300));
    }
  },
});

/** The three file-output tools. Always offered, like remember: producing a deliverable is part of the job. */
export const fileTools: ToolRegistration[] = [createFileTool, createPdfTool, publishFileTool];

export const fileToolsExtension = defineExtension({
  name: "file-output",
  tools: fileTools,
});

