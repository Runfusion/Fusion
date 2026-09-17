import { render,screen,fireEvent } from "@testing-library/react"; import { beforeEach,describe,expect,it,vi } from "vitest"; import type { WhiteboardDocument } from "@fusion/core";
const document:WhiteboardDocument={version:1,frames:[],texts:[],relations:[]};
const api=vi.hoisted(()=>({create:vi.fn(),select:vi.fn(),setSearch:vi.fn(),setDraftTitle:vi.fn(),setDraftDocument:vi.fn(),save:vi.fn(),rename:vi.fn(),remove:vi.fn(),loadRevisions:vi.fn(),restore:vi.fn(),reloadRemote:vi.fn(),createConflictCopy:vi.fn(),clearSelection:vi.fn()}));
const fixture=vi.hoisted(()=>({empty:false}));
vi.mock("../../hooks/useWhiteboards",()=>({useWhiteboards:()=>({ ...api,whiteboards:fixture.empty?[]:[{id:"one",title:"Même titre",revision:2,createdAt:"2026-01-01",updatedAt:"2026-01-02"},{id:"two",title:"Même titre",revision:1,createdAt:"2026-01-01",updatedAt:"2026-01-03"}],selected:fixture.empty?null:{id:"one",title:"Même titre",revision:2,createdAt:"2026-01-01",updatedAt:"2026-01-02",document},pendingSelectedId:null,draftTitle:fixture.empty?"":"Brouillon",draftDocument:fixture.empty?null:document,revisions:[],search:"",loading:false,saving:false,dirty:!fixture.empty,conflict:!fixture.empty,error:null})}));
vi.mock("../../hooks/useConfirm",()=>({useConfirm:()=>({confirm:vi.fn().mockResolvedValue(true)})})); vi.mock("../whiteboard/WhiteboardCanvas",()=>({WhiteboardCanvas:()=> <div data-testid="canvas"/>})); vi.mock("../whiteboard/whiteboard-export",()=>({exportWhiteboardJson:vi.fn(),exportWhiteboardPng:vi.fn()}));
import { WhiteboardView } from "../WhiteboardView";
describe("WhiteboardView",()=>{beforeEach(()=>{vi.clearAllMocks();fixture.empty=false;});it("rend les titres identiques avec identité, l'Alpha et toutes les sorties de conflit",()=>{render(<WhiteboardView projectId="p"/>);expect(screen.getByText("Alpha")).toBeInTheDocument();expect(screen.getAllByText("Même titre")).toHaveLength(2);expect(screen.getByTestId("canvas")).toBeInTheDocument();expect(screen.getByText(/draft is preserved/i)).toBeInTheDocument();fireEvent.click(screen.getByText(/Create copy from draft/i));expect(api.createConflictCopy).toHaveBeenCalledOnce();});it("expose sauvegarde, exports, historique et suppression sans bouton vide",()=>{render(<WhiteboardView projectId="p"/>);for(const name of [/Save/i,/JSON/i,/PNG/i,/History/i,/Delete/i]) expect(screen.getByRole("button",{name})).toBeInTheDocument();expect(screen.getAllByRole("button").every((button)=>Boolean(button.textContent?.trim()||button.getAttribute("aria-label")))).toBe(true);});it("omet le canvas sans projet ni brouillon sélectionné",()=>{fixture.empty=true;render(<WhiteboardView/>);expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();expect(screen.getByText("Select a project to use Whiteboard")).toBeInTheDocument();expect(screen.getByText("Select or create a whiteboard")).toBeInTheDocument();});
/*
FNXC:DashboardSearchField 2026-09-17-02:59:
FN-485 : Whiteboard portait la copie littérale du balisage défectueux de Notes (loupe hors du champ,
texte d'invite rendu visible par une classe `sr-only` jamais définie). L'invariant — icône et invite DANS
le champ, aucun libellé visible — doit tenir avec projet ET sans projet.
*/
for(const scenario of [{name:"avec projet",empty:false,props:{projectId:"p"}},{name:"sans projet",empty:true,props:{}}])
  it(`compose l'icône et l'invite dans le champ de recherche (${scenario.name})`,()=>{fixture.empty=scenario.empty;render(<WhiteboardView {...scenario.props}/>);
    const input=screen.getByRole("searchbox",{name:"Search whiteboards"}) as HTMLInputElement;
    expect(input).toHaveAttribute("placeholder","Search whiteboards");
    const field=input.closest(".search-field");
    expect(field).not.toBeNull();
    const icon=field!.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden","true");
    expect(icon!.parentElement).toBe(field);
    expect(window.document.querySelectorAll(".sr-only")).toHaveLength(0);
    expect(Array.from(window.document.querySelectorAll("*")).filter((el)=>el.children.length===0&&el.textContent?.trim()==="Search whiteboards")).toEqual([]);
    fireEvent.change(input,{target:{value:"plan"}});
    expect(api.setSearch).toHaveBeenCalledWith("plan");});});
