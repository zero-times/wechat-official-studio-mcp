# Write safety

Use this checklist for `wechat_official_upload_image` and `wechat_official_create_draft`.

## Allowed scope

- Upload JPEG, PNG, or GIF images from configured local upload roots.
- Save a new draft containing one to eight reviewed articles.
- Stop after draft creation. Publishing, mass-send, deletion, and existing-draft edits are outside this skill.

## Confirmation boundary

Before setting `confirm=true`, show the user:

- authenticated account name;
- every draft title and content length;
- each upload basename and intended usage;
- cover assignment, source URL, cover-display flag, and comment settings;
- all validator warnings.

Require explicit approval of this preview. If any title, content, file, setting, or account changes after approval, show the changed preview and confirm again.

## Local file boundary

- Never widen `WECHAT_OFFICIAL_UPLOAD_ROOTS` on the user's behalf.
- Never upload a path outside the configured roots.
- Never print the absolute path. Report only the basename, size, and detected MIME type.
- Reject symbolic-link escapes, unsupported formats, empty files, and oversized files.

## Ambiguous failures

For a timeout, connection drop, or non-JSON response after a write begins:

1. Do not retry automatically.
2. Tell the user the result may have succeeded upstream.
3. Ask them to inspect the material library or draft box.
4. Recheck authentication before an explicitly approved retry.

For an ordinary validation failure before the request is sent, fix the input and rerun validation; no account inspection is needed.
