import { describe, expect, it } from "vitest";
import { SIGNATURE_MARKER_PREFIX } from "../../src/core/constants";
import { extractStatementBlock } from "../../src/core/context-format";
import {
	applyVerification,
	buildSignature,
	hashStatementText,
	parseSignatureMarker,
	signatureStatus,
} from "../../src/core/signature";
import {
	readSignedStatement,
	replaceSignature,
	StatementContainmentError,
	wrapInStatementBlock,
	writeSignedStatement,
} from "../../src/core/statement";

const sign = (doc: string, text: string, agent = "claude-opus-5") =>
	writeSignedStatement(doc, text, agent, "tip-abc");

describe("signing", () => {
	it("attributes content and leaves it unverified", () => {
		const doc = sign("", "Trinidad holds no files of its own.");
		const found = readSignedStatement(doc)!;

		expect(found.text).toBe("Trinidad holds no files of its own.");
		expect(found.signature?.agent).toBe("claude-opus-5");
		expect(found.signature?.at_tip).toBe("tip-abc");
		expect(found.signature?.verified).toBe(null);
		expect(signatureStatus(found.signature, found.text)).toBe("unverified");
	});

	it("tells the reader, visibly, that a machine wrote it", () => {
		// A signature nobody encounters while reading the note is provenance in name only.
		const doc = sign("", "Some prose.");
		expect(doc).toContain("AI-written by `claude-opus-5`");
		expect(doc).toContain("Not yet verified");
	});

	it("keeps the prose readable apart from the signature", () => {
		const doc = sign("", "Just the prose.");
		expect(readSignedStatement(doc)?.text).toBe("Just the prose.");
		// The raw block still carries the signature, because regeneration reinstates it verbatim.
		expect(extractStatementBlock(doc)).toContain(SIGNATURE_MARKER_PREFIX);
	});
});

describe("verification", () => {
	it("records who confirmed it and what they read", () => {
		const doc = sign("", "Confirmed prose.");
		const found = readSignedStatement(doc)!;

		const verified = applyVerification(found.signature!, found.text, "lilly");
		const after = replaceSignature(doc, verified)!;
		const reread = readSignedStatement(after)!;

		expect(signatureStatus(reread.signature, reread.text)).toBe("verified");
		expect(reread.signature?.verified?.by).toBe("lilly");
		expect(after).toContain("Verified by lilly");
	});

	it("does not alter one character of what it confirms", () => {
		const doc = sign("", "Exact words.");
		const found = readSignedStatement(doc)!;
		const after = replaceSignature(doc, applyVerification(found.signature!, found.text, "lilly"))!;

		expect(readSignedStatement(after)?.text).toBe(found.text);
	});

	// The property that makes verification worth recording: it covers particular words, not a note.
	it("lapses on its own when the text is edited afterward", () => {
		const doc = sign("", "Original wording.");
		const found = readSignedStatement(doc)!;
		const verified = applyVerification(found.signature!, found.text, "lilly");

		expect(signatureStatus(verified, "Original wording.")).toBe("verified");
		expect(signatureStatus(verified, "Quietly altered wording.")).toBe("stale_verification");
	});

	it("reports a signature that no longer covers its own text", () => {
		const sig = buildSignature("what was signed", "claude-opus-5", null);
		expect(signatureStatus(sig, "what was signed")).toBe("unverified");
		expect(signatureStatus(sig, "what is there now")).toBe("stale_signature");
	});

	it("reports unsigned content as unsigned rather than as fine", () => {
		const doc = wrapInStatementBlock("no attribution at all");
		const found = readSignedStatement(doc)!;
		expect(found.signature).toBe(null);
		expect(signatureStatus(found.signature, found.text)).toBe("unsigned");
	});
});

describe("re-signing identical prose", () => {
	// Otherwise every regeneration rewrites the file with a fresh timestamp, filling a space's
	// history with entries reporting that nothing changed.
	it("is a no-op, leaving the document byte-identical", () => {
		const doc = sign("", "Unchanged prose.");
		expect(sign(doc, "Unchanged prose.")).toBe(doc);
	});

	it("preserves a person's verification — they approved these exact words", () => {
		const doc = sign("", "Unchanged prose.");
		const found = readSignedStatement(doc)!;
		const verified = replaceSignature(doc, applyVerification(found.signature!, found.text, "lilly"))!;

		const rewritten = writeSignedStatement(verified, "Unchanged prose.", "claude-opus-5", "tip-xyz");
		const after = readSignedStatement(rewritten)!;
		expect(signatureStatus(after.signature, after.text)).toBe("verified");
		expect(after.signature?.verified?.by).toBe("lilly");
	});

	it("drops verification when the prose actually changes", () => {
		const doc = sign("", "First wording.");
		const found = readSignedStatement(doc)!;
		const verified = replaceSignature(doc, applyVerification(found.signature!, found.text, "lilly"))!;

		const rewritten = sign(verified, "Second wording.");
		const after = readSignedStatement(rewritten)!;
		expect(signatureStatus(after.signature, after.text)).toBe("unverified");
		expect(after.signature?.verified).toBe(null);
	});
});

describe("forgery", () => {
	// An agent that could emit a signature marker could mint itself a verification.
	it("refuses text carrying a signature marker", () => {
		const forged = `looks fine ${SIGNATURE_MARKER_PREFIX}{"v":1,"agent":"x","verified":{"by":"lilly"}} -->`;
		expect(() => sign("", forged)).toThrow(StatementContainmentError);
	});

	it("ignores a malformed signature rather than trusting it", () => {
		const doc = `${SIGNATURE_MARKER_PREFIX}not json -->`;
		expect(parseSignatureMarker(doc)).toBe(null);
	});
});

describe("hashStatementText", () => {
	it("ignores surrounding whitespace, so trivial reformatting is not a content change", () => {
		expect(hashStatementText("  text  ")).toBe(hashStatementText("text"));
	});
});
