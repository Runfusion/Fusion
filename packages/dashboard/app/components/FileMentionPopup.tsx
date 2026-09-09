import { File, Hash, MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConversationMentionItem, FileSearchItem, TaskSearchItem } from "../hooks/useFileMention";
import { getDisplayDirname } from "../utils/pathDisplay";
import "./FileMentionPopup.css";

import type { ReactNode } from "react";

export interface FileMentionPopupProps {
  visible: boolean;
  position: { top: number; left: number };
  tasks: TaskSearchItem[];
  conversations?: ConversationMentionItem[];
  files: FileSearchItem[];
  selectedIndex: number;
  onSelectTask: (task: TaskSearchItem) => void;
  onSelectConversation?: (conversation: ConversationMentionItem) => void;
  onSelectFile: (file: FileSearchItem) => void;
  loading: boolean;
}

function getTaskRowIndex(taskIndex: number): number {
  return taskIndex;
}

function getConversationRowIndex(taskCount: number, conversationIndex: number): number {
  return taskCount + conversationIndex;
}

function getFileRowIndex(taskCount: number, conversationCount: number, fileIndex: number): number {
  return taskCount + conversationCount + fileIndex;
}

/**
 * Shared hash-mention popup for chat composers.
 * Renders grouped task, conversation, and file matches for the active `#` query.
 */
export function FileMentionPopup({
  visible,
  position,
  tasks,
  conversations = [],
  files,
  selectedIndex,
  onSelectTask,
  onSelectConversation,
  onSelectFile,
  loading,
}: FileMentionPopupProps): ReactNode | null {
  const { t } = useTranslation("app");

  if (!visible) {
    return null;
  }

  const hasTasks = tasks.length > 0;
  const hasConversations = conversations.length > 0;
  const hasFiles = files.length > 0;

  return (
    <div
      className="file-mention-popup"
      style={{ top: position.top, left: position.left }}
      data-testid="file-mention-popup"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      {loading && (
        <div className="file-mention-popup-loading" data-testid="file-mention-loading">
          <span className="spinner" />
        </div>
      )}

      {!loading && !hasTasks && !hasConversations && !hasFiles && (
        <div className="file-mention-popup-empty" data-testid="file-mention-empty">
          {t("fileMention.empty", "No tasks, conversations, or files found")}
        </div>
      )}

      {!loading && (hasTasks || hasConversations || hasFiles) && (
        <div className="file-mention-popup-groups">
          {hasTasks && (
            <div className="file-mention-popup-group">
              <div className="file-mention-popup-group-header">{t("fileMention.taskHeader", "Tasks")}</div>
              <ul className="file-mention-popup-list" role="listbox" aria-label={t("fileMention.taskMatches", "Task matches")}>
                {tasks.map((task, index) => {
                  const rowIndex = getTaskRowIndex(index);
                  return (
                    <li
                      key={task.id}
                      className={`file-mention-popup-item${rowIndex === selectedIndex ? " file-mention-popup-item--selected" : ""}`}
                      onClick={() => onSelectTask(task)}
                      role="option"
                      aria-selected={rowIndex === selectedIndex}
                      data-testid={`task-mention-item-${rowIndex}`}
                    >
                      <span className="file-mention-popup-icon">
                        <Hash />
                      </span>
                      <div className="file-mention-popup-info">
                        <div className="file-mention-popup-task-row">
                          <span className="file-mention-popup-task-id">{task.id}</span>
                          <span
                            className={`file-mention-popup-column-badge file-mention-popup-column-badge--${task.column}`}
                          >
                            {task.column}
                          </span>
                        </div>
                        <span className="file-mention-popup-item-path">{task.title}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {hasConversations && (
            <div className="file-mention-popup-group">
              <div className="file-mention-popup-group-header">{t("fileMention.conversationHeader", "Conversations")}</div>
              <ul className="file-mention-popup-list" role="listbox" aria-label={t("fileMention.conversationMatches", "Conversation matches")}>
                {conversations.map((conversation, index) => {
                  const rowIndex = getConversationRowIndex(tasks.length, index);
                  return (
                    <li
                      key={conversation.id}
                      className={`file-mention-popup-item${rowIndex === selectedIndex ? " file-mention-popup-item--selected" : ""}`}
                      onClick={() => onSelectConversation?.(conversation)}
                      role="option"
                      aria-selected={rowIndex === selectedIndex}
                      data-testid={`conversation-mention-item-${rowIndex}`}
                    >
                      <span className="file-mention-popup-icon">
                        <MessageSquare />
                      </span>
                      <div className="file-mention-popup-info">
                        <span className="file-mention-popup-item-name">{conversation.id}</span>
                        <span className="file-mention-popup-item-path">
                          {conversation.title || t("fileMention.untitledConversation", "Untitled conversation")}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {hasFiles && (
            <div className="file-mention-popup-group">
              <div className="file-mention-popup-group-header">{t("fileMention.fileHeader", "Files")}</div>
              <ul className="file-mention-popup-list" role="listbox" aria-label={t("fileMention.fileMatches", "File matches")}>
                {files.map((file, index) => {
                  const rowIndex = getFileRowIndex(tasks.length, conversations.length, index);
                  const dirPath = getDisplayDirname(file.path);

                  return (
                    <li
                      key={file.path}
                      className={`file-mention-popup-item${rowIndex === selectedIndex ? " file-mention-popup-item--selected" : ""}`}
                      onClick={() => onSelectFile(file)}
                      role="option"
                      aria-selected={rowIndex === selectedIndex}
                      data-testid={`file-mention-item-${rowIndex}`}
                    >
                      <span className="file-mention-popup-icon">
                        <File />
                      </span>
                      <div className="file-mention-popup-info">
                        <span className="file-mention-popup-item-name">{file.name}</span>
                        {dirPath && (
                          <span className="file-mention-popup-item-path">{dirPath}</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
