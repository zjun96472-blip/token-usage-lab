import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const root=path.resolve(import.meta.dirname,"..");
const release=path.join(root,"release");
fs.mkdirSync(release,{recursive:true});
for(const [source,target] of [
  ["src-tauri/target/x86_64-pc-windows-msvc/release/token-usage-lab.exe","TokenUsageLab.exe"],
  ["src-tauri/target/x86_64-pc-windows-msvc/release/usage-lab-cli.exe","usage-lab-cli.exe"],
  ["LICENSE","LICENSE"], ["README.md","README.md"],
]) fs.copyFileSync(path.join(root,source),path.join(release,target));
const digest=file=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const files=["TokenUsageLab.exe","usage-lab-cli.exe"].map(file=>({file,sha256:digest(path.join(release,file)),bytes:fs.statSync(path.join(release,file)).size}));
const sourceFiles=[];
const dirs=["src","src-tauri/src","scripts","tests","docs"];
function walk(dir) {for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else sourceFiles.push({file:path.relative(root,file).replaceAll("\\","/"),sha256:digest(file)});}}
dirs.forEach(dir=>walk(path.join(root,dir)));
const manifest={product:"Token Usage Lab",version:"0.1.0",builtAt:new Date().toISOString(),delivery:"local-uncommitted-candidate",
  baseline:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),
  branch:execFileSync("git",["branch","--show-current"],{cwd:root,encoding:"utf8"}).trim(),
  buildImage:"sha256:10fa1f350addf9c59345954f9d6eb10e353ba481c6130757a5c95d8daad37191",files,sourceFiles};
fs.writeFileSync(path.join(release,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
console.log(JSON.stringify({delivery:manifest.delivery,files}));
