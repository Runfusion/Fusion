import { describe, expect, it } from "vitest";
import { createEmptyWhiteboardDocument, validateWhiteboardDocument, WhiteboardValidationError, type WhiteboardDocumentV1 } from "../whiteboards/whiteboard-types.js";

const populated = (): WhiteboardDocumentV1 => ({ version: 1, frames: [{ id: "screen", type: "screen", x: 0, y: 0, width: 400, height: 300 }], texts: [{ id: "source", role: "title", text: "Décision", frameId: "screen", x: 20, y: 20 }, { id: "yes", role: "body", text: "Oui", x: 600, y: 10 }, { id: "no", role: "body", text: "Non", x: 600, y: 200 }], relations: [{ id: "choice", sourceId: "source", annotation: "Choisir", junction: { x: 500, y: 100 }, branches: [{ id: "b-yes", targetId: "yes", annotation: "Oui" }, { id: "b-no", targetId: "no", annotation: "Non" }] }] });
describe("validateWhiteboardDocument", () => {
  it("accepte un document vide et une relation multi-cibles structurée", () => { expect(validateWhiteboardDocument(createEmptyWhiteboardDocument())).toEqual(createEmptyWhiteboardDocument()); expect(validateWhiteboardDocument(populated())).toEqual(populated()); });
  it.each([
    ["identifiant dupliqué", (d: WhiteboardDocumentV1) => { d.texts[1]!.id = "source"; }],
    ["référence absente", (d: WhiteboardDocumentV1) => { d.relations[0]!.branches[0]!.targetId = "missing"; }],
    ["cible répétée", (d: WhiteboardDocumentV1) => { d.relations[0]!.branches[1]!.targetId = "yes"; }],
    ["valeur non finie", (d: WhiteboardDocumentV1) => { d.frames[0]!.x = Number.NaN; }],
    ["dimension négative", (d: WhiteboardDocumentV1) => { d.frames[0]!.width = -1; }],
    ["identifiant de branche dupliqué entre relations", (d: WhiteboardDocumentV1) => { d.relations.push({ id: "choice-two", sourceId: "no", branches: [{ id: "b-yes", targetId: "yes" }] }); }],
    ["cadre imbriqué par champ supplémentaire", (d: WhiteboardDocumentV1) => { (d.frames[0] as WhiteboardDocumentV1["frames"][number] & { frameId: string }).frameId = "screen"; }],
  ])("refuse %s", (_name, mutate) => { const d = populated(); mutate(d); expect(() => validateWhiteboardDocument(d)).toThrow(WhiteboardValidationError); });
  it("refuse les limites d'objets", () => { const d = createEmptyWhiteboardDocument(); d.frames = Array.from({ length: 501 }, (_, i) => ({ id: `f${i}`, type: "screen", x: 0, y: 0, width: 1, height: 1 })); expect(() => validateWhiteboardDocument(d)).toThrow(/limit/); });
});
