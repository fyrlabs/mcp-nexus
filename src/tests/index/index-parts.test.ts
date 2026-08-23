import { describe, expect, it, beforeEach } from "vitest";
import { deriveCapabilityId, withCollisionSuffix } from "../../index/capability-id.js";
import { tokenize, expandAliases, normalizeQuery, contentTokens } from "../../index/text.js";
import { classifyRisk, deriveKeywords, humanizeToolName } from "../../index/risk.js";
import { BM25Index, type LexicalDocument } from "../../index/bm25.js";
import { NullEmbeddingProvider, SemanticIndex, cosineSimilarity } from "../../index/semantic.js";

describe("index/capability-id", () => {
  it("derives canonical server.domain.operation ids", () => {
    expect(deriveCapabilityId("github", "list_pull_requests")).toBe("github.pull_requests.list");
    expect(deriveCapabilityId("jira", "search_issues")).toBe("jira.issues.search");
    expect(deriveCapabilityId("slack", "get-message")).toBe("slack.message.get");
  });

  it("falls back to the full tool name without a verb prefix", () => {
    expect(deriveCapabilityId("everything", "echo")).toBe("everything.echo");
    expect(deriveCapabilityId("srv", "addTwoNumbers")).toBe("srv.addtwonumbers");
  });

  it("appends deterministic collision suffixes", () => {
    const taken = new Set(["srv.echo"]);
    expect(withCollisionSuffix("srv.echo", taken)).toBe("srv.echo_2");
    taken.add("srv.echo_2");
    expect(withCollisionSuffix("srv.echo", taken)).toBe("srv.echo_3");
    expect(withCollisionSuffix("srv.unique", taken)).toBe("srv.unique");
  });
});

describe("index/text", () => {
  it("tokenizes and normalizes queries", () => {
    expect(tokenize("Find my PR comments!")).toEqual(["find", "my", "pr", "comments"]);
    expect(normalizeQuery("  Multiple   Spaces  ")).toBe("multiple spaces");
    expect(contentTokens("the quick brown fox the")).toEqual(["quick", "brown", "fox"]);
  });

  it("expands built-in and custom aliases on word boundaries", () => {
    const expanded = expandAliases("show my pr in repo x", { repo: "repository" });
    expect(expanded).toContain("pull request");
    expect(expanded).toContain("repository");
    expect(expandAliases("project", { ject: "should-not-match" })).toBe("project");
    expect(expandAliases("prs everywhere", {})).toBe("pull requests everywhere");
  });
});

describe("index/risk", () => {
  it("classifies destructive over write over read", () => {
    expect(classifyRisk("delete_repository")).toBe("destructive");
    expect(classifyRisk("create_issue")).toBe("write");
    expect(classifyRisk("list_pull_requests")).toBe("read");
    expect(classifyRisk("innocent_name", "permanently removes data")).toBe("destructive");
  });

  it("derives keywords and humanized titles", () => {
    expect(deriveKeywords("list_pull_requests", "List pull requests in a repository").slice(0, 3)).toEqual([
      "list",
      "pull",
      "requests",
    ]);
    expect(humanizeToolName("get-annotated-message")).toBe("Get Annotated Message");
  });
});

function doc(id: string, toolName: string, description: string): LexicalDocument {
  return {
    id,
    toolName,
    title: toolName.replace(/_/g, " "),
    description,
    tags: [],
    keywords: toolName.split("_"),
    serverId: id.split(".")[0] ?? "",
  };
}

describe("index/bm25", () => {
  let index: BM25Index;
  beforeEach(() => {
    index = new BM25Index();
    index.rebuild([
      doc("gh.pr.list", "list_pull_requests", "find and list pull requests for a repository"),
      doc("gh.issue.search", "search_issues", "search jira style issues with filters"),
      doc("slack.msg.search", "search_messages", "search slack messages by keyword"),
      doc("figma.export.pdf", "export_pdf", "export a figma document as pdf"),
    ]);
  });

  it("ranks exact term matches above unrelated documents", () => {
    const results = index.topK("pull request", 4);
    expect(results[0]?.id).toBe("gh.pr.list");
    const scores = new Map(results.map((entry) => [entry.id, entry.score]));
    expect(scores.get("figma.export.pdf") ?? 0).toBeLessThan(scores.get("gh.pr.list") ?? 0);
  });

  it("scores multi-term queries across fields and normalizes ordering", () => {
    const results = index.topK("search messages", 2);
    expect(results[0]?.id).toBe("slack.msg.search");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("supports incremental add/remove", () => {
    index.add(doc("new.tool", "ping_host", "ping a host to check latency"));
    expect(index.has("new.tool")).toBe(true);
    expect(index.topK("ping host", 1)[0]?.id).toBe("new.tool");
    index.remove("new.tool");
    expect(index.has("new.tool")).toBe(false);
    expect(index.size).toBe(4);
  });

  it("returns nothing for empty or unknown queries", () => {
    expect(index.topK("", 5)).toHaveLength(0);
    expect(index.topK("zzzqqq", 5)).toHaveLength(0);
  });
});

describe("index/semantic", () => {
  it("null provider disables semantic search", async () => {
    const semantic = new SemanticIndex(new NullEmbeddingProvider());
    expect(semantic.enabled).toBe(false);
    await expect(semantic.indexText("a", "text")).resolves.toBe(false);
    await expect(semantic.search("query", 5)).resolves.toEqual([]);
  });

  it("scores vectors by cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("indexes documents and returns similarity-ranked hits", async () => {
    const responses = [
      [1, 0, 0],
      [0.9, 0.1, 0],
      [0, 1, 0],
    ];
    const provider = {
      name: "scripted",
      dimensions: 3,
      active: true,
      embed: async (): Promise<number[]> => responses.shift() ?? [0, 0, 0],
    };
    const semantic = new SemanticIndex(provider as never);
    await semantic.indexText("aligned.doc", "text");
    await semantic.indexText("orthogonal.doc", "text");
    const hits = await semantic.search("find aligned", 5);
    expect(semantic.size).toBe(2);
    const top = hits.find((hit) => hit.id === "orthogonal.doc");
    const other = hits.find((hit) => hit.id === "aligned.doc");
    expect((top?.score ?? 0)).toBeGreaterThan(other?.score ?? -1);
    expect(top).toBeDefined();
    semantic.remove("orthogonal.doc");
    expect(semantic.size).toBe(1);
  });
});
