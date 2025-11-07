import fs from "fs";
import path from "path";
export function loadInstructions(p="./config/SUPER_ZYLO_INSTRUCTIONS_VENTAS.md"){
  return fs.readFileSync(path.resolve(p), "utf8");
}
