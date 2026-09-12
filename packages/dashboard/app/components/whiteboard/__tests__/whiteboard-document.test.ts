import { describe, expect, it } from "vitest";
import { applyWhiteboardCommand, copyWhiteboardSelection, createWhiteboardEditorState, pasteWhiteboardClipboard, redoWhiteboard, setWhiteboardSelection, undoWhiteboard } from "../whiteboard-document";
import type { WhiteboardDocument } from "@fusion/core";
const doc = (): WhiteboardDocument => ({ version:1, frames:[{id:"f",type:"screen",x:0,y:0,width:200,height:150}], texts:[{id:"a",role:"idea",text:"A",frameId:"f",x:10,y:10},{id:"b",role:"body",text:"B",x:300,y:0},{id:"c",role:"body",text:"C",x:300,y:100}], relations:[{id:"r",sourceId:"a",junction:{x:250,y:50},branches:[{id:"yes",targetId:"b",annotation:"Oui"},{id:"no",targetId:"c",annotation:"Non"}]}] });
describe("whiteboard commands",()=>{
 it("déplace un cadre sans réécrire les coordonnées locales de ses textes et annule exactement",()=>{ const state=createWhiteboardEditorState(doc()); const moved=applyWhiteboardCommand(state,{type:"move",ids:["f","a"],dx:50,dy:30}); expect(moved.document.frames[0]).toMatchObject({x:50,y:30}); expect(moved.document.texts[0]).toMatchObject({x:10,y:10}); expect(undoWhiteboard(moved).document).toEqual(doc()); expect(redoWhiteboard(undoWhiteboard(moved)).document).toEqual(moved.document); });
 it("borne le resize au contenu du cadre",()=>{ const resized=applyWhiteboardCommand(createWhiteboardEditorState(doc()),{type:"resize-frame",id:"f",width:1,height:1}); expect(resized.document.frames[0]!.width).toBeGreaterThan(80); expect(resized.past).toHaveLength(1); });
 it("duplique un cadre, ses textes et seulement les branches remappables",()=>{ let i=0; const duplicated=applyWhiteboardCommand(createWhiteboardEditorState(doc()),{type:"duplicate",ids:["f","b"],idFactory:()=>`new-${++i}`}); expect(duplicated.document.frames).toHaveLength(2); expect(duplicated.document.texts).toHaveLength(5); expect(duplicated.document.relations).toHaveLength(2); expect(duplicated.document.relations[1]!.branches).toHaveLength(1); });
 it("copie-colle avec un presse-papiers interne et remappe les identités",()=>{let i=0;let state=setWhiteboardSelection(createWhiteboardEditorState(doc()),["f","b"]);state=copyWhiteboardSelection(state);state=applyWhiteboardCommand(state,{type:"delete",ids:["f","b"]});const pasted=pasteWhiteboardClipboard(state,()=>`paste-${++i}`);expect(pasted.document.frames).toHaveLength(1);expect(pasted.document.texts.some(x=>x.id.startsWith("paste-"))).toBe(true);expect(pasted.document.relations).toHaveLength(2); expect(pasted.document.relations.every(r=>r.branches.every(b=>pasted.document.texts.some(t=>t.id===b.targetId)))).toBe(true);});
 it("nettoie les branches pendantes à la suppression",()=>{ const deleted=applyWhiteboardCommand(createWhiteboardEditorState(doc()),{type:"delete",ids:["b"]}); expect(deleted.document.relations[0]!.branches.map(x=>x.targetId)).toEqual(["c"]); });
 it("édite texte et annotations libres, Oui, Non ou absentes",()=>{ let state=createWhiteboardEditorState(doc()); state=applyWhiteboardCommand(state,{type:"edit-text",id:"a",text:"Décider"}); state=applyWhiteboardCommand(state,{type:"annotate-relation",relationId:"r",annotation:"libre"}); state=applyWhiteboardCommand(state,{type:"annotate-branch",relationId:"r",branchId:"yes",annotation:undefined}); expect(state.document.texts[0]!.text).toBe("Décider"); expect(state.document.relations[0]!.annotation).toBe("libre"); expect(state.document.relations[0]!.branches[0]).toEqual({id:"yes",targetId:"b",annotation:undefined}); });
 it("conserve la même référence pour les sélections normalisées équivalentes",()=>{
   const empty=createWhiteboardEditorState(doc());
   expect(setWhiteboardSelection(empty,[])).toBe(empty);
   expect(setWhiteboardSelection(empty,["missing","missing"])).toBe(empty);

   const populated=setWhiteboardSelection(empty,["a","r","yes"]);
   expect(setWhiteboardSelection(populated,["a","a","missing","r","yes","yes"])).toBe(populated);
   expect(setWhiteboardSelection(populated,["a","r","yes"])).toBe(populated);
 });
 it("normalise les sélections modifiées dans l'ordre canonique reçu",()=>{
   const state=createWhiteboardEditorState(doc());
   const selected=setWhiteboardSelection(state,["no","f","a","r","yes","no","invalid"]);
   expect(selected).not.toBe(state);
   expect(selected.selectedIds).toEqual(["no","f","a","r","yes"]);
   expect(selected.document).toBe(state.document);
   expect(selected.past).toBe(state.past);
   expect(setWhiteboardSelection(selected,[]).selectedIds).toEqual([]);
 });
});
