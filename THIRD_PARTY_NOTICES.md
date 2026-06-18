# Third-Party Notices

This project is licensed under the MIT License. The following runtime dependencies are distributed under permissive licenses compatible with this project goal.

| Package | License | Use |
| --- | --- | --- |
| `mp4-muxer` | MIT | Browser-side MP4 muxing for WebCodecs exports. |
| `reveal.js` | MIT | Browser-native HTML slide decks. |
| `pptxgenjs` | MIT | PowerPoint deck generation. |
| `three` | MIT | Optional immersive page 3D rendering. |
| `zod` | MIT | Runtime schema validation. |
| `express` | MIT | HTTP server. |
| `playwright` | Apache-2.0 | Browser validation and inspection. |
| `lucide-react` | ISC | Admin UI icons. |

Paid, source-available, or copyleft media renderers and prebuilt media encoder binaries are intentionally not bundled into the core video presentation feature.

When adding media export dependencies, keep the default MCP core limited to MIT, Apache-2.0, ISC, BSD, or similarly permissive licenses. Do not vendor non-permissive, source-available, or paid-license rendering engines into the default distribution.
