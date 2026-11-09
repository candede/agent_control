import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { crc32 } from "node:zlib";

function customerKit() {
  const directory = new URL("./public/customer-kit/adoption-intelligence/", import.meta.url);
  const files = readdirSync(directory).sort().map(path => ({ path, bytes: readFileSync(new URL(path, directory)) }));
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.bytes).update("\0");
  const prompts = JSON.parse(readFileSync(new URL("prompts.json", directory), "utf8"));
  const employeePrompts = JSON.stringify({
    contract: { role: prompts.contract.employeeRole, evidenceChecklist: prompts.contract.evidenceChecklist,
      outputChecklist: prompts.contract.outputChecklist, failureThreshold: prompts.contract.failureThreshold },
    prompts: prompts.prompts.filter((prompt: { role: string }) => prompt.role === "employee"),
    conversations: prompts.conversations.filter((conversation: { role: string }) => conversation.role === "employee"),
  });
  files.push({ path: "employee-prompts.json", bytes: Buffer.from(employeePrompts) });
  const manifest = JSON.stringify({ version: hash.digest("hex"), files: files.map(file => ({
    path: file.path, bytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex"),
  })) });
  // Deterministic stored ZIP: no dependency, subprocess, timestamp or tenant data.
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(`adoption-intelligence/${file.path}`);
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(file.bytes), 14);
    header.writeUInt32LE(file.bytes.length, 18); header.writeUInt32LE(file.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8); entry.writeUInt32LE(crc32(file.bytes), 16);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(file.bytes.length, 20); entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, name, file.bytes); central.push(entry, name);
    offset += header.length + name.length + file.bytes.length;
  }
  const end = Buffer.alloc(22), index = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return { manifest, employeePrompts, zip: Buffer.concat([...local, index, end]) };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: "customer-kit",
    generateBundle() {
      const kit = customerKit();
      this.emitFile({ type: "asset", fileName: "customer-kit/manifest.json", source: kit.manifest });
      this.emitFile({ type: "asset", fileName: "customer-kit/adoption-intelligence.zip", source: kit.zip });
      this.emitFile({ type: "asset", fileName: "customer-kit/adoption-intelligence/employee-prompts.json", source: kit.employeePrompts });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!["/customer-kit/manifest.json", "/customer-kit/adoption-intelligence.zip",
          "/customer-kit/adoption-intelligence/employee-prompts.json"].includes(request.url ?? "")) return next();
        const kit = customerKit(), zip = request.url?.endsWith(".zip");
        response.setHeader("Content-Type", zip ? "application/zip" : "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(zip ? kit.zip : request.url?.endsWith("employee-prompts.json") ? kit.employeePrompts : kit.manifest);
      });
    },
  }],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
