import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const root=path.resolve(import.meta.dirname,"..");
const source=/\.(rs|tsx?|jsx?|mjs|cjs|ps1|sh|css|html|sql)$/;
const text=/\.(rs|tsx?|jsx?|mjs|cjs|ps1|sh|css|html|sql|json|md|toml|ya?ml|lock)$/;
const skip=new Set([".git",".tooling",".acceptance","node_modules","dist","release","target","gen"]);
let count=0, largest={path:"",lines:0};
function walk(directory) {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    if(skip.has(entry.name) || entry.isSymbolicLink()) continue;
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()) {walk(file);continue;}
    if(!text.test(file)) continue;
    const bytes=fs.readFileSync(file);
    assert(!(bytes[0]===239 && bytes[1]===187 && bytes[2]===191),`UTF-8 BOM: ${file}`);
    const value=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    assert(!value.includes("\uFFFD"),`Replacement character: ${file}`);
    if(source.test(file)) {
      const lines=value.split("\n").length;
      assert(lines<=3000,`Source exceeds 3000 lines: ${file} (${lines})`);
      if(lines>largest.lines) largest={path:path.relative(root,file),lines};
      count++;
    }
  }
}
walk(root);
console.log(JSON.stringify({result:"PASS",sourceFiles:count,largest,encoding:"UTF-8 without BOM"}));
