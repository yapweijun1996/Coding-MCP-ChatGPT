# Agent Delivery Reliability

This document defines the default delivery workflow for ChatGPT and other AI agents using the Coding MCP project tools.

## Default delivery path

For new static HTML/CSS/JS deliverables, agents should call `deliver_static_project` first.

The tool performs the full delivery gate:

1. Create a persistent project under `.projects/{projectId}/`.
2. Write all submitted text files.
3. Run static validation with profile `static_html`.
4. Temporarily publish the project entry file.
5. Run Playwright browser validation across desktop, tablet, and mobile viewports.
6. Keep the public `publishedUrl` only if validation passes.
7. Return compatible MCP text JSON plus `structuredContent`.

## Recommended agent behavior

- Use `deliver_static_project` for normal one-shot deliverables.
- Return `publishedUrl` only when the tool returns `ok:true`.
- If `ok:false`, inspect `structuredContent.validation`, `structuredContent.browserInspection`, and `inspectionReportUrl`.
- Use `get_project_activity` to explain what happened or continue an incremental repair.
- Do not use legacy `create_share` for project deliverables.
- Use lower-level `create_project`, `write_project_file`, `validate_project`, and `publish_and_report` only for repair or incremental workflows.

## Static validation

The `static_html` validation profile checks:

- Project path safety.
- Entry file existence.
- File size limits.
- Basic HTML structure for `.html` entry files.
- Local resources referenced by HTML `src`, `href`, and `srcset` attributes.

A missing local reference such as `href="style.css"` without a matching project file blocks delivery.

## Browser validation

Browser validation reuses the shared Playwright inspection helper used by `inspect_webpage`.

Blocking failures:

- Browser page errors.
- Browser console errors.
- Horizontal overflow in any checked viewport.
- Layout issues marked as `error` by the inspector.

Non-blocking warnings:

- Small tap targets.
- Empty document title.
- Static HTML warnings that are not hard errors.

If browser validation fails, the project is unpublished back to `draft`, `publishedUrl` is cleared, and the inspection report remains available as a legacy share report URL for debugging.

## Structured result contract

`deliver_static_project`, `get_project_manifest`, `get_project_activity`, `validate_project`, and `publish_and_report` return both:

- Legacy MCP text JSON in `content[0].text`.
- Compatible `structuredContent` for clients that can consume structured tool output.

Important fields for `deliver_static_project`:

- `ok`
- `projectId`
- `publishedUrl`
- `validation`
- `browserInspection`
- `inspectionReportUrl`
- `files`
- `nextActions`

## Admin visibility

Admin project detail pages show:

- Project manifest.
- Last validation result.
- Browser inspection report link when present.
- Task history.
- File tree and read-only code viewer.

Projects blocked by browser validation remain visible in Admin as draft projects, so the agent or operator can inspect and repair them later.

## Verification checklist

After changes to delivery behavior, run:

```bash
npm run build
npm test
npm run check:mcp
```

Recommended MCP smoke scenarios:

- `deliver_static_project` succeeds and returns a public URL with HTTP 200.
- Missing local CSS/JS reference blocks static validation.
- Console error or horizontal overflow blocks browser validation.
- Browser-blocked project returns HTTP 404 at `/share/{projectId}/index.html`.
- `get_project_activity` shows `deliver_static_project` task history.
- PM2 restart preserves successful published URLs and failed draft states.
