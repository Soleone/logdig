import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

export async function checkDirectory(directory, { writable = false, allowMissing = false } = {}) {
  let existing = directory;
  while (true) {
    try {
      const info = await stat(existing);
      if (!info.isDirectory()) throw new Error(`Not a folder: ${existing}`);
      await access(existing, constants.X_OK | (writable ? constants.R_OK | constants.W_OK : constants.R_OK));
      return { exists: existing === directory };
    } catch (error) {
      if (error.code !== "ENOENT" || !allowMissing) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}
