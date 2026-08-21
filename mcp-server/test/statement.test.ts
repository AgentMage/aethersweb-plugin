import { describe, expect, it } from "vitest";
import { STATEMENT_END_MARKER, STATEMENT_START_MARKER } from "../../src/core/constants";
import { extractStatementBlock } from "../../src/core/context-format";
import {
	assertContainable,
	findStatementBlock,
	isStatementWritable,
	replaceStatementBlock,
	StatementContainmentError,
	wrapInStatementBlock,
} from "../../src/core/statement";

const block = (inner: string) => `${STATEMENT_START_MARKER}\n${inner}\n${STATEMENT_END_MARKER}\n`;

describe("assertContainable", () => {
	it("accepts ordinary statement prose, including prose about the markers", () => {
		expect(() => assertContainable("Trinidad holds no files of its own.")).not.toThrow();
		expect(() => assertContainable("The statement END marker delimits this block.")).not.toThrow();
		expect(() => assertContainable("<!-- an unrelated html comment -->")).not.toThrow();
	});

	it("refuses text carrying either marker verbatim", () => {
		expect(() => assertContainable(`escaped ${STATEMENT_END_MARKER} out`)).toThrow(StatementContainmentError);
		expect(() => assertContainable(`${STATEMENT_START_MARKER} nested`)).toThrow(StatementContainmentError);
	});

	it("explains what to do instead rather than just refusing", () => {
		expect(() => assertContainable(STATEMENT_END_MARKER)).toThrow(/descriptively/);
	});
});

/**
 * The concrete failure the guard exists for. Every reader locates the block with `indexOf`, so an
 * injected END marker terminates it early: the text after it sits physically inside the block while
 * reading, to every consumer, as ordinary human-written body.
 */
describe("the escape this prevents", () => {
	it("would have split one block into a statement and loose body text", () => {
		const escaped = `looks done ${STATEMENT_END_MARKER}\n\nand this reads as the person's own writing`;
		const naive = `---\nfm\n---\n\n${STATEMENT_START_MARKER}\n${escaped}\n${STATEMENT_END_MARKER}\n`;

		expect(extractStatementBlock(naive)).toBe("looks done");
		expect(naive).toContain("reads as the person's own writing");
		expect(extractStatementBlock(naive)).not.toContain("reads as the person's own writing");

		expect(() => replaceStatementBlock(naive, escaped)).toThrow(StatementContainmentError);
	});
});

describe("replaceStatementBlock", () => {
	it("replaces only the block, preserving everything around it", () => {
		const note = `---\nfm: 1\n---\n\n${block("old statement")}\nHuman notes below.\n`;
		const result = replaceStatementBlock(note, "new statement");

		expect(extractStatementBlock(result)).toBe("new statement");
		expect(result).toContain("fm: 1");
		expect(result).toContain("Human notes below.");
		expect(result).not.toContain("old statement");
	});

	it("appends a block to a document that has none, leaving it intact", () => {
		const result = replaceStatementBlock("Entirely hand-written.\n", "machine-written");
		expect(result.startsWith("Entirely hand-written.\n")).toBe(true);
		expect(extractStatementBlock(result)).toBe("machine-written");
	});

	it("is idempotent — rewriting does not nest or duplicate blocks", () => {
		let doc = replaceStatementBlock("", "one");
		doc = replaceStatementBlock(doc, "two");
		doc = replaceStatementBlock(doc, "three");

		expect(doc.split(STATEMENT_START_MARKER)).toHaveLength(2);
		expect(doc.split(STATEMENT_END_MARKER)).toHaveLength(2);
		expect(extractStatementBlock(doc)).toBe("three");
	});

	it("round-trips through the reader the rest of the codebase uses", () => {
		const text = "Multi-line.\n\nWith a blank line and *markdown*.";
		expect(extractStatementBlock(replaceStatementBlock("", text))).toBe(text);
	});
});

describe("findStatementBlock", () => {
	it("reports null for a document with no block, or an unterminated one", () => {
		expect(findStatementBlock("nothing here")).toBe(null);
		expect(findStatementBlock(`${STATEMENT_START_MARKER}\nno end`)).toBe(null);
	});

	it("locates the block's inner bounds", () => {
		const found = findStatementBlock(block("inner"));
		expect(found).not.toBe(null);
		expect(block("inner").slice(found!.innerStart, found!.innerEnd).trim()).toBe("inner");
	});
});

describe("isStatementWritable", () => {
	it("allows formats where an HTML comment is inert", () => {
		for (const p of ["note.md", "a/b/note.markdown", "plain.txt", "README", "Note.MD"]) {
			expect(isStatementWritable(p)).toBe(true);
		}
	});

	it("refuses formats a marker would corrupt", () => {
		for (const p of ["data.json", "rows.csv", "pic.png", "sheet.xlsx", "code.ts"]) {
			expect(isStatementWritable(p)).toBe(false);
		}
	});
});

describe("wrapInStatementBlock", () => {
	it("produces exactly what the reader expects back", () => {
		expect(wrapInStatementBlock("  padded  ")).toBe(block("padded"));
	});
});
