// Deterministic drag-to-Applications disk image; no Finder automation required.
import {mkdtempSync,cpSync,symlinkSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
if(process.platform!=='darwin')throw new Error('DMG packaging requires macOS');
const target=process.argv[2];
const root=resolve('src-tauri/target',...(target?[target]:[]),'release/bundle');
const version=JSON.parse(readFileSync('package.json','utf8')).version;
const output=join(root,'dmg',`U-Words_${version}_${process.arch}.dmg`);
const stage=mkdtempSync(join(tmpdir(),'uwords-dmg-'));
try{
  cpSync(join(root,'macos/U-Words.app'),join(stage,'U-Words.app'),{recursive:true});
  symlinkSync('/Applications',join(stage,'Applications'));
  mkdirSync(join(root,'dmg'),{recursive:true});
  execFileSync('/usr/bin/hdiutil',['create','-volname','U-Words','-srcfolder',stage,'-format','UDZO','-ov',output],{stdio:'inherit'});
  execFileSync('/usr/bin/hdiutil',['verify',output],{stdio:'inherit'});
  console.log(output);
}finally{rmSync(stage,{recursive:true,force:true});}
