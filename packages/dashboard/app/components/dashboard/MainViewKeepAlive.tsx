import { Suspense, useCallback, useRef, type ComponentProps } from "react";
import { Board } from "../Board";
import { CapacityRiskBanner } from "../CapacityRiskBanner";
import { PageErrorBoundary } from "../ErrorBoundary";
import { KeepAliveView } from "../KeepAliveView";
import { ListView } from "../ListView";
import { AlphaMobileDrawer } from "../AlphaMobileDrawer";
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
  alphaMobileDrawer?: {
    activeId: Exclude<KeepAliveMainViewId, "board"> | null;
    title: string;
    onClose: () => void;
  };
}

function renderBoardSubtree(
  props: MainContentProps,
  active: boolean,
  onOpenHistory: () => void,
  onOpenRefine: NonNullable<ComponentProps<typeof Board>["onOpenRefine"]>,
  onReviseTask: NonNullable<ComponentProps<typeof Board>["onReviseTask"]>,
) {
  const {
    capacityRiskBannerEnabled,
    capacityRiskDismissed,
    capacityRiskSignal,
    handleDismissCapacityRisk,
    filteredBoardTasks,
    currentProject,
    isRemote,
    maxConcurrent,
    maxWorktrees,
    showWorktreeGrouping,
    moveTask,
    pauseTask,
    openBoardTaskDetail,
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
    revertTask,
    deleteTask,
    loadMoreCurrentTasks,
    currentTasksTotal,
    currentTasksHasMore,
    currentTasksLoadingMore,
    currentTasksPaginationError,
    currentTasksProgressKey,
    retryCurrentTasksPagination,
    loadMoreCompletedTasks,
    completedCounts,
    completedHasMore,
    completedLoadingMore,
    completedPaginationError,
    completedProgressKey,
    retryCompletedTasksPagination,
    completedSortMode,
    changeCompletedSortMode,
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
    experimentalFeatures,
  } = props;
  /*
  FNXC:WorkflowControls 2026-09-12-05:41:
  Alpha desktop replaces the navigation sidebar with a footer but still owns the Header workflow slot. Board and List must portal their selector beside Search whenever Alpha is active, while retained inactive views continue to release that shared slot.
  */
  const workflowControlsInHeader = sidebarActive || isMobile || experimentalFeatures?.alphaUpdates === true;

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
        onOpenRefine={onOpenRefine}
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
        onRevertTask={revertTask}
        onReviseTask={onReviseTask}
        onDeleteTask={deleteTask}
        onLoadMoreCurrentTasks={isRemote ? undefined : loadMoreCurrentTasks}
        currentTasksTotal={isRemote ? undefined : currentTasksTotal}
        currentTasksHasMore={isRemote ? false : currentTasksHasMore}
        currentTasksLoadingMore={isRemote ? false : currentTasksLoadingMore}
        currentTasksPaginationError={isRemote ? null : currentTasksPaginationError}
        currentTasksProgressKey={isRemote ? undefined : currentTasksProgressKey}
        onRetryCurrentTasks={isRemote ? undefined : retryCurrentTasksPagination}
        onLoadMoreCompletedTasks={isRemote ? undefined : loadMoreCompletedTasks}
        completedCounts={isRemote ? undefined : completedCounts}
        completedHasMore={isRemote ? false : completedHasMore}
        completedLoadingMore={isRemote ? false : completedLoadingMore}
        completedPaginationError={isRemote ? null : completedPaginationError}
        completedProgressKey={isRemote ? undefined : completedProgressKey}
        onRetryCompletedTasks={isRemote ? undefined : retryCompletedTasksPagination}
        completedSortMode={completedSortMode}
        onCompletedSortModeChange={changeCompletedSortMode}
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
        workflowControlsInHeader={workflowControlsInHeader}
        alphaUpdatesEnabled={experimentalFeatures?.alphaUpdates === true}
        onOpenHistory={onOpenHistory}
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
    loadMoreCurrentTasks,
    currentTasksHasMore,
    currentTasksLoadingMore,
    currentTasksPaginationError,
    currentTasksProgressKey,
    retryCurrentTasksPagination,
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
    experimentalFeatures,
  } = props;
  const workflowControlsInHeader = sidebarActive || isMobile || experimentalFeatures?.alphaUpdates === true;

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
        onLoadMoreCurrentTasks={isRemote ? undefined : loadMoreCurrentTasks}
        currentTasksHasMore={isRemote ? false : currentTasksHasMore}
        currentTasksLoadingMore={isRemote ? false : currentTasksLoadingMore}
        currentTasksPaginationError={isRemote ? null : currentTasksPaginationError}
        currentTasksProgressKey={isRemote ? undefined : currentTasksProgressKey}
        onRetryCurrentTasks={isRemote ? undefined : retryCurrentTasksPagination}
        lastFetchTimeMs={lastFetchTimeMs}
        prAuthAvailable={prAuthAvailable}
        autoMerge={autoMerge}
        openMobileTasksInPopup={openMobileTasksInPopup}
        taskDetailChatFirst={taskDetailChatFirst}
        mergeStrategy={mergeStrategy}
        onOpenWorkflowEditor={openWorkflowEditorWithNav}
        onCreateWorkflow={openCreateWorkflowWithNav}
        workflowControlsInHeader={workflowControlsInHeader}
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

function renderMainViewSubtree(
  id: KeepAliveMainViewId,
  props: MainContentProps,
  active: boolean,
  onOpenHistory: () => void,
  onOpenRefine: NonNullable<ComponentProps<typeof Board>["onOpenRefine"]>,
  onReviseTask: NonNullable<ComponentProps<typeof Board>["onReviseTask"]>,
) {
  switch (id) {
    case "board":
      return renderBoardSubtree(props, active, onOpenHistory, onOpenRefine, onReviseTask);
    case "list":
      return renderListSubtree(props, active);
    case "chat":
      return renderChatSubtree(props, active);
  }
}

export function MainViewKeepAlive({ activeId, mountedIds, projectKey, mainContentProps, alphaMobileDrawer }: MainViewKeepAliveProps) {
  /*
  FNXC:HistoryRenderStability 2026-09-12-23:15:
  Alpha window or drawer routing rerenders this retained host while Board data stays unchanged. Keep
  every locally adapted column action stable while forwarding to the latest owners, so opening History cannot invalidate memoized workflow columns through History, Refine, or Revise callback identity churn.
  */
  const mainContentPropsRef = useRef(mainContentProps);
  mainContentPropsRef.current = mainContentProps;
  const handleOpenHistory = useCallback(() => {
    mainContentPropsRef.current.handleChangeTaskView("patchnode");
  }, []);
  const handleOpenRefine = useCallback<NonNullable<ComponentProps<typeof Board>["onOpenRefine"]>>((task) => {
    mainContentPropsRef.current.openDetailTask(task, undefined, { initialAction: "refine" });
  }, []);
  const handleReviseTask = useCallback<NonNullable<ComponentProps<typeof Board>["onReviseTask"]>>((task) => {
    mainContentPropsRef.current.modalManager.openNewTaskWithDescription(task.description);
  }, []);

  return (
    <>
      {mountedIds.map((id) => {
        const isDrawerView = alphaMobileDrawer !== undefined && id !== "board";
        const isActive = activeId === id || (alphaMobileDrawer !== undefined && id === "board");
        const subtree = (
          <KeepAliveView key={`${projectKey}:${id}`} hidden={!isActive} testId={`${id}-keep-alive`}>
            {renderMainViewSubtree(id, mainContentProps, isActive, handleOpenHistory, handleOpenRefine, handleReviseTask)}
          </KeepAliveView>
        );
        if (!isDrawerView) return subtree;
        return (
          <AlphaMobileDrawer
            key={`${projectKey}:${id}`}
            open={alphaMobileDrawer.activeId === id}
            title={alphaMobileDrawer.title}
            onClose={alphaMobileDrawer.onClose}
            keepMounted
            testId={`alpha-mobile-drawer-${id}`}
            contentOwnsHeader
            contentOwnsScroll
          >
            {subtree}
          </AlphaMobileDrawer>
        );
      })}
    </>
  );
}
