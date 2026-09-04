import { Suspense } from "react";
import { Board } from "../Board";
import { CapacityRiskBanner } from "../CapacityRiskBanner";
import { PageErrorBoundary } from "../ErrorBoundary";
import { KeepAliveView } from "../KeepAliveView";
import { ListView } from "../ListView";
import type { MainContentProps } from "./types";

/*
FNXC:MainViewKeepAlive 2026-08-30-19:05:
Board, List, and Chat mount after their first visit for one project, then remain mounted through
KeepAliveView so returning restores their in-view state. A hidden entry gets active={false}, which
releases shared header ownership and read acknowledgements; adding an id to this registry requires
the same side-effect audit.

`hidden` and `active` are two faces of one resolved per-entry value. Computing isActive once here
makes a hidden-but-live wrapper unrepresentable, including callers that hide the whole layer by
passing activeId={null}.
*/
export const KEEP_ALIVE_MAIN_VIEW_IDS = ["board", "list", "chat"] as const;
export type KeepAliveMainViewId = (typeof KEEP_ALIVE_MAIN_VIEW_IDS)[number];

export function isKeepAliveMainViewId(taskView: string): taskView is KeepAliveMainViewId {
  return (KEEP_ALIVE_MAIN_VIEW_IDS as readonly string[]).includes(taskView);
}

export interface MainViewKeepAliveProps {
  activeId: KeepAliveMainViewId | null;
  mountedIds: readonly KeepAliveMainViewId[];
  projectKey: string;
  mainContentProps: MainContentProps;
}

function renderBoardSubtree(props: MainContentProps, active: boolean) {
  const {
    capacityRiskBannerEnabled,
    capacityRiskDismissed,
    capacityRiskSignal,
    handleDismissCapacityRisk,
    filteredBoardTasks,
    currentProject,
    maxConcurrent,
    maxWorktrees,
    showWorktreeGrouping,
    moveTask,
    pauseTask,
    openBoardTaskDetail,
    openDetailTask,
    openGroupModalWithNav,
    addToast,
    handleBoardQuickCreate,
    openNewTaskWithNav,
    openPlanningWithInitialPlanWithNav,
    autoMerge,
    mergeStrategy,
    toggleAutoMerge,
    planAutoApproveEnabled,
    togglePlanAutoApprove,
    globalPaused,
    updateTask,
    retryTask,
    onOpenChatWithPrefill,
    unpauseTask,
    resetTask,
    duplicateTask,
    mergeTask,
    archiveTask,
    unarchiveTask,
    revertTask,
    modalManager,
    deleteTask,
    archiveAllDone,
    loadArchivedTasks,
    loadMoreArchivedTasks,
    archivedSortMode,
    changeArchivedSortMode,
    archivedHasMore,
    archivedLoadingMore,
    searchQuery,
    availableModels,
    handleOpenDetailWithTab,
    favoriteProviders,
    favoriteModels,
    handleToggleFavorite,
    handleToggleModelFavorite,
    staleHighFanoutBlockerAgeThresholdMs,
    handleOpenMission,
    lastFetchTimeMs,
    prAuthAvailable,
    openWorkflowEditorWithNav,
    openCreateWorkflowWithNav,
    sidebarActive,
    isMobile,
  } = props;

  return (
    <PageErrorBoundary>
      {capacityRiskBannerEnabled && !capacityRiskDismissed ? (
        <CapacityRiskBanner signal={capacityRiskSignal} onDismiss={handleDismissCapacityRisk} />
      ) : null}
      <Board
        tasks={filteredBoardTasks}
        projectId={currentProject?.id}
        maxConcurrent={maxConcurrent}
        maxWorktrees={maxWorktrees}
        showWorktreeGrouping={showWorktreeGrouping}
        onMoveTask={moveTask}
        onPauseTask={pauseTask}
        onOpenDetail={openBoardTaskDetail}
        onOpenRefine={(task) => openDetailTask(task, undefined, { initialAction: "refine" })}
        onOpenGroupModal={openGroupModalWithNav}
        addToast={addToast}
        onQuickCreate={handleBoardQuickCreate}
        onNewTask={openNewTaskWithNav}
        onPlanningMode={openPlanningWithInitialPlanWithNav}
        autoMerge={autoMerge}
        mergeStrategy={mergeStrategy}
        onToggleAutoMerge={toggleAutoMerge}
        planAutoApproveEnabled={planAutoApproveEnabled}
        onTogglePlanAutoApprove={togglePlanAutoApprove}
        globalPaused={globalPaused}
        onUpdateTask={updateTask}
        onRetryTask={retryTask}
        onOpenChatWithPrefill={onOpenChatWithPrefill}
        onUnpauseTask={unpauseTask}
        onResetTask={resetTask}
        onDuplicateTask={duplicateTask}
        onMergeTask={mergeTask}
        onArchiveTask={archiveTask}
        onUnarchiveTask={unarchiveTask}
        onRevertTask={revertTask}
        onReviseTask={(task) => modalManager.openNewTaskWithDescription(task.description)}
        onDeleteTask={deleteTask}
        onArchiveAllDone={archiveAllDone}
        onLoadArchivedTasks={loadArchivedTasks}
        onLoadMoreArchivedTasks={loadMoreArchivedTasks}
        archivedSortMode={archivedSortMode}
        onArchivedSortModeChange={changeArchivedSortMode}
        archivedHasMore={archivedHasMore}
        archivedLoadingMore={archivedLoadingMore}
        searchQuery={searchQuery}
        availableModels={availableModels}
        onOpenDetailWithTab={handleOpenDetailWithTab}
        favoriteProviders={favoriteProviders}
        favoriteModels={favoriteModels}
        onToggleFavorite={handleToggleFavorite}
        onToggleModelFavorite={handleToggleModelFavorite}
        staleHighFanoutBlockerAgeThresholdMs={staleHighFanoutBlockerAgeThresholdMs}
        onOpenMission={handleOpenMission}
        lastFetchTimeMs={lastFetchTimeMs}
        prAuthAvailable={prAuthAvailable}
        onOpenWorkflowEditor={openWorkflowEditorWithNav}
        onCreateWorkflow={openCreateWorkflowWithNav}
        workflowControlsInHeader={sidebarActive || isMobile}
        active={active}
      />
    </PageErrorBoundary>
  );
}

function renderListSubtree(props: MainContentProps, active: boolean) {
  const {
    isRemote,
    remoteData,
    tasks,
    currentProject,
    moveTask,
    retryTask,
    onOpenChatWithPrefill,
    deleteTask,
    modalManager,
    pauseTask,
    unpauseTask,
    archiveTask,
    revertTask,
    mergeTask,
    resetTask,
    duplicateTask,
    ingestCreatedTasks,
    openDetailTask,
    popOutTaskDetail,
    addToast,
    globalPaused,
    openNewTaskWithNav,
    handleBoardQuickCreate,
    openPlanningWithInitialPlanWithNav,
    availableModels,
    favoriteProviders,
    favoriteModels,
    handleToggleFavorite,
    handleToggleModelFavorite,
    searchQuery,
    lastFetchTimeMs,
    prAuthAvailable,
    autoMerge,
    openMobileTasksInPopup,
    taskDetailChatFirst,
    mergeStrategy,
    openWorkflowEditorWithNav,
    openCreateWorkflowWithNav,
    sidebarActive,
    isMobile,
  } = props;

  return (
    <PageErrorBoundary>
      <ListView
        tasks={isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : tasks}
        projectId={currentProject?.id}
        onMoveTask={moveTask}
        onRetryTask={retryTask}
        onOpenChatWithPrefill={onOpenChatWithPrefill}
        onDeleteTask={deleteTask}
        onReviseTask={(task) => modalManager.openNewTaskWithDescription(task.description)}
        onPauseTask={pauseTask}
        onUnpauseTask={unpauseTask}
        onArchiveTask={archiveTask}
        onRevertTask={revertTask}
        onMergeTask={mergeTask}
        onResetTask={resetTask}
        onDuplicateTask={duplicateTask}
        onRefinementCreated={(task) => ingestCreatedTasks([task])}
        onOpenDetail={(task, options) => openDetailTask(task, undefined, options)}
        onPopOut={popOutTaskDetail}
        addToast={addToast}
        globalPaused={globalPaused}
        onNewTask={openNewTaskWithNav}
        onQuickCreate={handleBoardQuickCreate}
        onPlanningMode={openPlanningWithInitialPlanWithNav}
        availableModels={availableModels}
        favoriteProviders={favoriteProviders}
        favoriteModels={favoriteModels}
        onToggleFavorite={handleToggleFavorite}
        onToggleModelFavorite={handleToggleModelFavorite}
        searchQuery={searchQuery}
        lastFetchTimeMs={lastFetchTimeMs}
        prAuthAvailable={prAuthAvailable}
        autoMerge={autoMerge}
        openMobileTasksInPopup={openMobileTasksInPopup}
        taskDetailChatFirst={taskDetailChatFirst}
        mergeStrategy={mergeStrategy}
        onOpenWorkflowEditor={openWorkflowEditorWithNav}
        onCreateWorkflow={openCreateWorkflowWithNav}
        workflowControlsInHeader={sidebarActive || isMobile}
        active={active}
      />
    </PageErrorBoundary>
  );
}

function renderChatSubtree(props: MainContentProps, active: boolean) {
  const {
    ChatView,
    currentProject,
    addToast,
    experimentalFeatures,
    chatComposerPrefill,
    setQuickChatOpen,
    onOpenSessionInNewWindow,
    onSendAsReport,
  } = props;
  return (
    <PageErrorBoundary>
      <Suspense fallback={null}>
        <ChatView
          key={currentProject?.id ?? "all-projects"}
          addToast={addToast}
          projectId={currentProject?.id}
          experimentalFeatures={experimentalFeatures}
          initialComposerDraft={chatComposerPrefill?.text}
          initialComposerDraftNonce={chatComposerPrefill?.nonce}
          onPopOut={() => setQuickChatOpen(true)}
          onOpenSessionInNewWindow={onOpenSessionInNewWindow}
          onSendAsReport={onSendAsReport}
          findActive={active}
          active={active}
        />
      </Suspense>
    </PageErrorBoundary>
  );
}

function renderMainViewSubtree(id: KeepAliveMainViewId, props: MainContentProps, active: boolean) {
  switch (id) {
    case "board":
      return renderBoardSubtree(props, active);
    case "list":
      return renderListSubtree(props, active);
    case "chat":
      return renderChatSubtree(props, active);
  }
}

export function MainViewKeepAlive({ activeId, mountedIds, projectKey, mainContentProps }: MainViewKeepAliveProps) {
  return (
    <>
      {mountedIds.map((id) => {
        const isActive = activeId === id;
        return (
          <KeepAliveView key={`${projectKey}:${id}`} hidden={!isActive} testId={`${id}-keep-alive`}>
            {renderMainViewSubtree(id, mainContentProps, isActive)}
          </KeepAliveView>
        );
      })}
    </>
  );
}
