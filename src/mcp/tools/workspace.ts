import { legacyDelegatedTools } from "./legacy-delegate.js";

export const workspaceTools = legacyDelegatedTools([
  "write_file",
  "list_dir",
  "read_file",
  "search_files",
  "replace_in_file",
  "create_directory",
  "copy_file",
  "file_exists",
  "symlink_info",
  "chmod_mode",
  "tail_file",
  "delete_file",
  "rename_file",
  "file_info",
  "file_hash",
  "folder_size"
]);
