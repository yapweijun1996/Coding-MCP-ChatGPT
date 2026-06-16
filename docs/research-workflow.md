# Research Delivery Workflow

This MCP does not provide web search. ChatGPT performs web search, compares sources, and writes the report. The MCP provides a persistent research workspace for source tracking, evidence records, report files, validation, and publishing.

## Default agent flow

1. Call `create_research_project` with the research title and brief.
2. Use ChatGPT web search outside MCP to identify sources.
3. Call `add_research_source` once per source with claim, summary, confidence, and tags.
4. Call `inspect_webpage` only for important pages that need browser-level evidence.
5. Call `record_research_evidence` to attach inspection report URLs or other evidence summaries.
6. Call `add_research_note` for findings, contradictions, open questions, and methodology notes.
7. Call `write_research_report` with agent-authored `report.md` and complete `report.html`.
8. Call `publish_research_report`; return `publishedUrl` only when the tool returns `ok:true`.

## Project file layout

```text
.projects/{projectId}/files/
  research/
    research.json
    sources/
      source_001.json
      source_002.json
    notes/
      findings.md
      contradictions.md
      open-questions.md
      methodology.md
    evidence/
      inspections.json
  report.md
  report.html
```

## Source records

Each source is stored as `research/sources/source_NNN.json`.

Required fields:

- `id`
- `title`
- `url`
- `claim`
- `summary`
- `confidence`: `low`, `medium`, or `high`
- `tags`
- `usedInReport`
- `addedAt`

The source URL must start with `http://` or `https://`. The MCP does not fetch or search the URL when a source is added.

## Evidence records

Evidence records are appended to `research/evidence/inspections.json`.

Use `record_research_evidence` for:

- `inspect_webpage` report URLs.
- Manual source-check summaries.
- Structured evidence copied from another approved tool.

Evidence is optional for every source. Publishing does not require each source to have browser inspection evidence.

## Publish validation

`publish_research_report` runs a research manifest check before normal project publish validation.

The research check requires:

- `research/research.json`.
- At least one source.
- `report.md`.
- `report.html`.
- `report.html` references at least one source id or source URL.
- Sources marked `usedInReport:true` include title, URL, claim, summary, and confidence.

If validation fails, the project remains draft and the failure is recorded in project task history.
