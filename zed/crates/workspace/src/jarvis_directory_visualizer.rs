use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Instant,
};

use git::repository::{LogOrder, LogSource};
use gpui::{
    AnyView, App, BoxShadow, Context, Entity, Hsla, MouseButton, Pixels, Render, SharedString,
    Size, StatefulInteractiveElement, Subscription, Window, canvas, div, hsla, point, px, size,
};
use project::{
    Project, WorktreeId,
    git_store::{CommitDataState, GitStoreEvent, RepositoryEvent},
};
use ui::{TintColor, Tooltip, prelude::*};
use util::rel_path::RelPath;

const DEFAULT_MAX_DEPTH: usize = 3;
const MAX_GRAPH_NODES: usize = 250;
const DEFAULT_GRAPH_ZOOM: f32 = 0.82;
const MIN_GRAPH_ZOOM: f32 = 0.35;
const MAX_GRAPH_ZOOM: f32 = 1.35;
const GRAPH_ZOOM_STEP: f32 = 0.15;
const LARGE_GRAPH_NODE_THRESHOLD: usize = 180;
const LARGE_GRAPH_REPULSION_STRIDE: usize = 3;
const MIN_NODE_RADIUS: f32 = 3.5;
const FILE_NODE_RADIUS: f32 = 4.0;
const DIRECTORY_NODE_RADIUS: f32 = 6.0;
const ROOT_NODE_RADIUS: f32 = 10.0;
const SELECTOR_PANEL_WIDTH: Pixels = px(272.);
const CHAT_PANEL_WIDTH: Pixels = px(420.);
const MAX_SELECTOR_ROWS: usize = 120;
const MAX_GIT_COMMITS: usize = 12;
const MAX_GIT_CHANGED_PATHS: usize = 8;
const MAX_THREAD_ROWS: usize = 80;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct DirectoryGraphNodeId {
    worktree_id: WorktreeId,
    path: Arc<RelPath>,
}

impl DirectoryGraphNodeId {
    fn new(worktree_id: WorktreeId, path: Arc<RelPath>) -> Self {
        Self { worktree_id, path }
    }

    fn root(worktree_id: WorktreeId) -> Self {
        Self {
            worktree_id,
            path: RelPath::empty().into_arc(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DirectoryGraphNodeKind {
    Root,
    Directory,
    File,
}

#[derive(Clone, Debug)]
pub(crate) struct DirectoryGraphNode {
    pub(crate) id: DirectoryGraphNodeId,
    pub(crate) label: SharedString,
    pub(crate) path_label: SharedString,
    pub(crate) kind: DirectoryGraphNodeKind,
    pub(crate) depth: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct DirectoryGraphEdge {
    pub(crate) parent: DirectoryGraphNodeId,
    pub(crate) child: DirectoryGraphNodeId,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct DirectoryGraph {
    pub(crate) nodes: Vec<DirectoryGraphNode>,
    pub(crate) edges: Vec<DirectoryGraphEdge>,
    pub(crate) omitted_count: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct DirectoryGraphWorktreeInput {
    pub(crate) worktree_id: WorktreeId,
    pub(crate) root_name: SharedString,
    pub(crate) entries: Vec<DirectoryGraphEntryInput>,
}

#[derive(Clone, Debug)]
pub(crate) struct DirectoryGraphEntryInput {
    pub(crate) path: Arc<RelPath>,
    pub(crate) is_dir: bool,
    pub(crate) is_ignored: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct GraphPoint {
    x: f32,
    y: f32,
}

impl GraphPoint {
    fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    fn add_assign(&mut self, rhs: GraphPoint) {
        self.x += rhs.x;
        self.y += rhs.y;
    }

    fn scale(self, scale: f32) -> Self {
        Self {
            x: self.x * scale,
            y: self.y * scale,
        }
    }

    fn clamp(self, min_x: f32, max_x: f32, min_y: f32, max_y: f32) -> Self {
        Self {
            x: self.x.clamp(min_x, max_x),
            y: self.y.clamp(min_y, max_y),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct SimNode {
    position: GraphPoint,
    velocity: GraphPoint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NodeSelectorFilter {
    All,
    Roots,
    Directories,
    Files,
}

impl NodeSelectorFilter {
    fn all() -> [Self; 4] {
        [Self::All, Self::Roots, Self::Directories, Self::Files]
    }

    fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Roots => "Roots",
            Self::Directories => "Folders",
            Self::Files => "Files",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::All => IconName::ListTree,
            Self::Roots => IconName::GitWorktree,
            Self::Directories => IconName::Folder,
            Self::Files => IconName::File,
        }
    }

    fn includes(self, kind: DirectoryGraphNodeKind) -> bool {
        match self {
            Self::All => true,
            Self::Roots => kind == DirectoryGraphNodeKind::Root,
            Self::Directories => kind == DirectoryGraphNodeKind::Directory,
            Self::Files => kind == DirectoryGraphNodeKind::File,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JarvisLeftPanelMode {
    Directory,
    Git,
    Threads,
}

impl JarvisLeftPanelMode {
    fn all() -> [Self; 3] {
        [Self::Directory, Self::Git, Self::Threads]
    }

    fn label(self) -> &'static str {
        match self {
            Self::Directory => "Map",
            Self::Git => "Git",
            Self::Threads => "Threads",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::Directory => IconName::FileTree,
            Self::Git => IconName::GitCommit,
            Self::Threads => IconName::Thread,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct JarvisGitCommitSummary {
    pub sha: SharedString,
    pub short_sha: SharedString,
    pub subject: SharedString,
    pub author: SharedString,
    pub changed_paths: Vec<SharedString>,
    pub omitted_changed_paths: usize,
    pub changes_loading: bool,
}

#[derive(Clone, Debug, Default)]
pub struct JarvisThreadSummary {
    pub title: SharedString,
    pub prompt: SharedString,
    pub status: SharedString,
    pub changed_paths: Vec<SharedString>,
    pub latest_events: Vec<SharedString>,
}

pub(crate) struct JarvisDirectoryVisualizer {
    project: Option<Entity<Project>>,
    graph: DirectoryGraph,
    sim_nodes: HashMap<DirectoryGraphNodeId, SimNode>,
    hovered_node: Option<DirectoryGraphNodeId>,
    pinned_node: Option<DirectoryGraphNodeId>,
    expanded_nodes: HashSet<DirectoryGraphNodeId>,
    left_panel_mode: JarvisLeftPanelMode,
    selector_filter: NodeSelectorFilter,
    graph_zoom: f32,
    git_commits: Vec<JarvisGitCommitSummary>,
    git_loading: bool,
    git_error: Option<SharedString>,
    loading_git_diffs: HashSet<SharedString>,
    thread_summaries: Vec<JarvisThreadSummary>,
    chat_view: Option<AnyView>,
    last_frame: Option<Instant>,
    _project_subscription: Option<Subscription>,
    _git_subscription: Option<Subscription>,
}

impl JarvisDirectoryVisualizer {
    pub(crate) fn new(project: Entity<Project>, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            project: None,
            graph: DirectoryGraph::default(),
            sim_nodes: HashMap::default(),
            hovered_node: None,
            pinned_node: None,
            expanded_nodes: HashSet::default(),
            left_panel_mode: JarvisLeftPanelMode::Directory,
            selector_filter: NodeSelectorFilter::All,
            graph_zoom: DEFAULT_GRAPH_ZOOM,
            git_commits: Vec::new(),
            git_loading: false,
            git_error: None,
            loading_git_diffs: HashSet::default(),
            thread_summaries: Vec::new(),
            chat_view: None,
            last_frame: None,
            _project_subscription: None,
            _git_subscription: None,
        };
        this.set_project(project, cx);
        this
    }

    pub(crate) fn set_project(&mut self, project: Entity<Project>, cx: &mut Context<Self>) {
        if self
            .project
            .as_ref()
            .is_some_and(|current| current == &project)
        {
            return;
        }

        self.project = Some(project.clone());
        let git_store = project.read(cx).git_store().clone();
        self._project_subscription = Some(cx.subscribe(&project, |this, _, event, cx| {
            if matches!(
                event,
                project::Event::WorktreeAdded(_)
                    | project::Event::WorktreeRemoved(_)
                    | project::Event::WorktreeOrderChanged
                    | project::Event::WorktreeUpdatedEntries(_, _)
                    | project::Event::WorktreePathsChanged { .. }
            ) {
                this.rebuild_graph(cx);
            }
        }));
        self._git_subscription = Some(cx.subscribe(&git_store, |this, _, event, cx| {
            if matches!(
                event,
                GitStoreEvent::ActiveRepositoryChanged(_)
                    | GitStoreEvent::RepositoryAdded
                    | GitStoreEvent::RepositoryRemoved(_)
                    | GitStoreEvent::RepositoryUpdated(
                        _,
                        RepositoryEvent::HeadChanged | RepositoryEvent::GraphEvent(_, _),
                        _
                    )
            ) {
                this.refresh_git_commits(cx);
            }
        }));
        self.rebuild_graph(cx);
        self.refresh_git_commits(cx);
    }

    pub(crate) fn set_chat_view(&mut self, chat_view: Option<AnyView>, cx: &mut Context<Self>) {
        self.chat_view = chat_view;
        cx.notify();
    }

    pub(crate) fn set_thread_summaries(
        &mut self,
        thread_summaries: Vec<JarvisThreadSummary>,
        cx: &mut Context<Self>,
    ) {
        self.thread_summaries = thread_summaries;
        cx.notify();
    }

    fn set_graph_zoom(&mut self, zoom: f32, cx: &mut Context<Self>) {
        self.graph_zoom = zoom.clamp(MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM);
        cx.notify();
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn node_count(&self) -> usize {
        self.graph.nodes.len()
    }

    fn rebuild_graph(&mut self, cx: &mut Context<Self>) {
        self.graph = self
            .project
            .as_ref()
            .map(|project| build_graph_from_project(project, cx))
            .unwrap_or_default();
        self.retain_live_sim_nodes();
        cx.notify();
    }

    fn retain_live_sim_nodes(&mut self) {
        let live_nodes = self
            .graph
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<HashSet<_>>();

        self.sim_nodes.retain(|id, _| live_nodes.contains(id));

        if self
            .hovered_node
            .as_ref()
            .is_some_and(|id| !live_nodes.contains(id))
        {
            self.hovered_node = None;
        }

        if self
            .pinned_node
            .as_ref()
            .is_some_and(|id| !live_nodes.contains(id))
        {
            self.pinned_node = None;
        }

        self.expanded_nodes.retain(|id| live_nodes.contains(id));
    }

    fn active_highlight_node(&self) -> Option<DirectoryGraphNodeId> {
        self.hovered_node
            .clone()
            .or_else(|| self.pinned_node.clone())
    }

    fn detail_node(&self) -> Option<&DirectoryGraphNode> {
        let id = self.pinned_node.as_ref().or(self.hovered_node.as_ref())?;
        self.graph.nodes.iter().find(|node| &node.id == id)
    }

    fn node_by_id(&self, id: &DirectoryGraphNodeId) -> Option<&DirectoryGraphNode> {
        self.graph.nodes.iter().find(|node| &node.id == id)
    }

    fn folder_child_count(&self, id: &DirectoryGraphNodeId) -> usize {
        self.graph
            .edges
            .iter()
            .filter(|edge| &edge.parent == id)
            .filter(|edge| {
                self.node_by_id(&edge.child)
                    .is_some_and(|node| node.kind != DirectoryGraphNodeKind::File)
            })
            .count()
    }

    fn file_child_count(&self, id: &DirectoryGraphNodeId) -> usize {
        self.graph
            .edges
            .iter()
            .filter(|edge| &edge.parent == id)
            .filter(|edge| {
                self.node_by_id(&edge.child)
                    .is_some_and(|node| node.kind == DirectoryGraphNodeKind::File)
            })
            .count()
    }

    fn parent_node(&self, id: &DirectoryGraphNodeId) -> Option<&DirectoryGraphNode> {
        let parent_id = &self
            .graph
            .edges
            .iter()
            .find(|edge| &edge.child == id)?
            .parent;
        self.node_by_id(parent_id)
    }

    fn visible_node_ids(&self) -> HashSet<DirectoryGraphNodeId> {
        visible_node_ids_for_graph(&self.graph, &self.expanded_nodes)
    }

    fn activate_node(&mut self, node_id: DirectoryGraphNodeId, cx: &mut Context<Self>) {
        let expandable = self
            .node_by_id(&node_id)
            .is_some_and(|node| node.kind != DirectoryGraphNodeKind::File);

        if expandable && !self.expanded_nodes.insert(node_id.clone()) {
            self.expanded_nodes.remove(&node_id);
        }

        self.pinned_node = Some(node_id);
        cx.notify();
    }

    fn graph_counts(&self) -> (usize, usize, usize) {
        self.graph.nodes.iter().fold((0, 0, 0), |mut counts, node| {
            match node.kind {
                DirectoryGraphNodeKind::Root => counts.0 += 1,
                DirectoryGraphNodeKind::Directory => counts.1 += 1,
                DirectoryGraphNodeKind::File => counts.2 += 1,
            }
            counts
        })
    }

    fn is_large_graph(&self) -> bool {
        self.graph.nodes.len() >= LARGE_GRAPH_NODE_THRESHOLD || self.graph.omitted_count > 0
    }

    fn refresh_git_commits(&mut self, cx: &mut Context<Self>) {
        let Some(project) = self.project.as_ref() else {
            self.git_commits.clear();
            self.git_loading = false;
            self.git_error = None;
            return;
        };

        let git_store = project.read(cx).git_store().clone();
        let Some(repository) = git_store.read(cx).active_repository() else {
            self.git_commits.clear();
            self.git_loading = false;
            self.git_error = None;
            return;
        };

        let (commits, is_loading, error) = repository.update(cx, |repository, cx| {
            let graph_data =
                repository.graph_data(LogSource::All, LogOrder::DateOrder, 0..MAX_GIT_COMMITS, cx);
            (
                graph_data
                    .commits
                    .iter()
                    .map(|commit| commit.sha)
                    .collect::<Vec<_>>(),
                graph_data.is_loading,
                graph_data.error.clone(),
            )
        });

        self.git_loading = is_loading;
        self.git_error = error;

        let existing_changes = self
            .git_commits
            .iter()
            .map(|commit| {
                (
                    commit.sha.clone(),
                    (
                        commit.changed_paths.clone(),
                        commit.omitted_changed_paths,
                        commit.changes_loading,
                    ),
                )
            })
            .collect::<HashMap<_, _>>();

        let mut next_commits = Vec::new();
        let mut diff_loads = Vec::new();
        repository.update(cx, |repository, cx| {
            for sha in commits {
                let sha_string = sha.to_string();
                let sha_shared: SharedString = sha_string.clone().into();
                let short_sha = short_sha(&sha_string);
                let (subject, author) = match repository.fetch_commit_data(sha, false, cx) {
                    CommitDataState::Loaded(data) => {
                        (data.subject.clone(), data.author_name.clone())
                    }
                    CommitDataState::Loading(_) => (short_sha.clone().into(), "Loading".into()),
                };
                let (changed_paths, omitted_changed_paths, mut changes_loading) = existing_changes
                    .get(&sha_shared)
                    .cloned()
                    .unwrap_or_default();

                if changed_paths.is_empty()
                    && !self.loading_git_diffs.contains(&sha_shared)
                    && !changes_loading
                {
                    changes_loading = true;
                    self.loading_git_diffs.insert(sha_shared.clone());
                    diff_loads.push((
                        sha_string.clone(),
                        repository.load_commit_diff(sha_string.clone()),
                    ));
                }

                next_commits.push(JarvisGitCommitSummary {
                    sha: sha_shared,
                    short_sha: short_sha.into(),
                    subject,
                    author,
                    changed_paths,
                    omitted_changed_paths,
                    changes_loading,
                });
            }
        });

        self.git_commits = next_commits;

        for (sha, diff_rx) in diff_loads {
            cx.spawn(async move |this, cx| {
                let result = diff_rx.await;
                this.update(cx, |this, cx| {
                    let sha: SharedString = sha.into();
                    this.loading_git_diffs.remove(&sha);
                    if let Some(commit) =
                        this.git_commits.iter_mut().find(|commit| commit.sha == sha)
                    {
                        commit.changes_loading = false;
                        if let Ok(Ok(diff)) = result {
                            let total = diff.files.len();
                            commit.changed_paths = diff
                                .files
                                .into_iter()
                                .take(MAX_GIT_CHANGED_PATHS)
                                .map(|file| {
                                    let status = match file.status() {
                                        git::repository::CommitFileStatus::Added => "added",
                                        git::repository::CommitFileStatus::Modified => "modified",
                                        git::repository::CommitFileStatus::Deleted => "deleted",
                                    };
                                    format!("{} {}", status, file.path.as_unix_str()).into()
                                })
                                .collect();
                            commit.omitted_changed_paths =
                                total.saturating_sub(commit.changed_paths.len());
                        }
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }

        cx.notify();
    }

    fn connected_node_ids(
        &self,
        active_id: Option<&DirectoryGraphNodeId>,
    ) -> HashSet<DirectoryGraphNodeId> {
        let mut connected = HashSet::default();
        let Some(active_id) = active_id else {
            return connected;
        };

        connected.insert(active_id.clone());
        for edge in &self.graph.edges {
            if &edge.parent == active_id {
                connected.insert(edge.child.clone());
            } else if &edge.child == active_id {
                connected.insert(edge.parent.clone());
            }
        }
        connected
    }

    fn ensure_sim_nodes(&mut self, canvas_size: Size<Pixels>, nodes: &[DirectoryGraphNode]) {
        let width = f32::from(canvas_size.width).max(320.);
        let height = f32::from(canvas_size.height).max(240.);
        let center = GraphPoint::new(width / 2., height / 2.);

        for (ix, node) in nodes.iter().enumerate() {
            self.sim_nodes.entry(node.id.clone()).or_insert_with(|| {
                let angle = ix as f32 * 2.399_963_1;
                let radius = 42. + (ix % 21) as f32 * 8.;
                SimNode {
                    position: GraphPoint::new(
                        center.x + angle.cos() * radius,
                        center.y + angle.sin() * radius,
                    )
                    .clamp(24., width - 24., 24., height - 24.),
                    velocity: GraphPoint::default(),
                }
            });
        }
    }

    fn step_simulation(&mut self, canvas_size: Size<Pixels>) {
        if self.graph.nodes.is_empty() {
            self.last_frame = None;
            return;
        }

        let visible_node_ids = self.visible_node_ids();
        let visible_nodes = self
            .graph
            .nodes
            .iter()
            .filter(|node| visible_node_ids.contains(&node.id))
            .cloned()
            .collect::<Vec<_>>();

        if visible_nodes.is_empty() {
            self.last_frame = None;
            return;
        }

        self.ensure_sim_nodes(canvas_size, &visible_nodes);

        let now = Instant::now();
        let elapsed = self
            .last_frame
            .replace(now)
            .map(|last| now.saturating_duration_since(last).as_secs_f32())
            .unwrap_or(1. / 60.);
        let time_scale = (elapsed * 60.).clamp(0.35, 1.5);

        let width = f32::from(canvas_size.width).max(320.);
        let height = f32::from(canvas_size.height).max(240.);
        let center = GraphPoint::new(width / 2., height / 2.);

        let mut forces = visible_nodes
            .iter()
            .map(|node| (node.id.clone(), GraphPoint::default()))
            .collect::<HashMap<_, _>>();

        for edge in &self.graph.edges {
            if !visible_node_ids.contains(&edge.parent) || !visible_node_ids.contains(&edge.child) {
                continue;
            }
            let Some(parent) = self.sim_nodes.get(&edge.parent).copied() else {
                continue;
            };
            let Some(child) = self.sim_nodes.get(&edge.child).copied() else {
                continue;
            };

            let dx = child.position.x - parent.position.x;
            let dy = child.position.y - parent.position.y;
            let distance = (dx * dx + dy * dy).sqrt().max(0.01);
            let target = 72.;
            let strength = (distance - target) * 0.0048;
            let force = GraphPoint::new(dx / distance * strength, dy / distance * strength);

            if let Some(parent_force) = forces.get_mut(&edge.parent) {
                parent_force.add_assign(force);
            }
            if let Some(child_force) = forces.get_mut(&edge.child) {
                child_force.add_assign(force.scale(-1.));
            }
        }

        let node_positions = visible_nodes
            .iter()
            .filter_map(|node| {
                self.sim_nodes
                    .get(&node.id)
                    .map(|sim_node| (node.id.clone(), sim_node.position))
            })
            .collect::<Vec<_>>();
        let large_graph = visible_nodes.len() >= LARGE_GRAPH_NODE_THRESHOLD;
        let repulsion_stride = if large_graph {
            LARGE_GRAPH_REPULSION_STRIDE
        } else {
            1
        };

        for ix in 0..node_positions.len() {
            for jx in (ix + 1)..node_positions.len() {
                if repulsion_stride > 1 && (ix + jx) % repulsion_stride != 0 {
                    continue;
                }
                let (left_id, left_position) = &node_positions[ix];
                let (right_id, right_position) = &node_positions[jx];
                let dx = right_position.x - left_position.x;
                let dy = right_position.y - left_position.y;
                let distance_sq = (dx * dx + dy * dy).max(16.);
                let distance = distance_sq.sqrt();
                let strength = ((820. * repulsion_stride as f32) / distance_sq)
                    .min(if large_graph { 0.55 } else { 0.9 });
                let force = GraphPoint::new(dx / distance * strength, dy / distance * strength);

                if let Some(left_force) = forces.get_mut(left_id) {
                    left_force.add_assign(force.scale(-1.));
                }
                if let Some(right_force) = forces.get_mut(right_id) {
                    right_force.add_assign(force);
                }
            }
        }

        for node in visible_nodes {
            let Some(sim_node) = self.sim_nodes.get_mut(&node.id) else {
                continue;
            };
            let mut force = forces.remove(&node.id).unwrap_or_default();
            let center_strength = if node.kind == DirectoryGraphNodeKind::Root {
                0.004
            } else {
                0.0018
            };
            force.add_assign(GraphPoint::new(
                (center.x - sim_node.position.x) * center_strength,
                (center.y - sim_node.position.y) * center_strength,
            ));

            sim_node.velocity.add_assign(force.scale(time_scale));
            sim_node.velocity = sim_node
                .velocity
                .scale(if large_graph { 0.82 } else { 0.86 });
            sim_node
                .position
                .add_assign(sim_node.velocity.scale(time_scale));

            let radius = radius_for_node_kind(node.kind);
            sim_node.position = sim_node.position.clamp(
                radius + 12.,
                width - radius - 12.,
                radius + 12.,
                height - radius - 12.,
            );
        }
    }
}

impl Render for JarvisDirectoryVisualizer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = cx.theme().colors();
        let window_size = window.window_bounds().get_bounds().size;
        let canvas_size = size(
            (window_size.width - SELECTOR_PANEL_WIDTH - CHAT_PANEL_WIDTH - px(24.)).max(px(320.)),
            (window_size.height - px(112.)).max(px(240.)),
        );

        self.step_simulation(canvas_size);
        if !self.graph.nodes.is_empty() {
            window.request_animation_frame();
        }

        let entity = cx.entity();
        let highlight_node = self.active_highlight_node();
        let connected_nodes = self.connected_node_ids(highlight_node.as_ref());
        let canvas_highlight_node = highlight_node.clone();
        let graph_zoom = self.graph_zoom;
        let visible_node_ids = self.visible_node_ids();
        let visible_edges = self
            .graph
            .edges
            .iter()
            .filter(|edge| {
                visible_node_ids.contains(&edge.parent) && visible_node_ids.contains(&edge.child)
            })
            .cloned()
            .collect::<Vec<_>>();
        let visible_node_count = visible_node_ids.len();
        let visible_edge_count = visible_edges.len();
        let large_graph = self.is_large_graph();
        let positions = self
            .sim_nodes
            .iter()
            .map(|(id, node)| (id.clone(), node.position))
            .collect::<HashMap<_, _>>();
        let edge_color = colors.text_muted.opacity(0.22);
        let highlighted_edge_color = colors.text_accent.opacity(0.76);
        let panel_bg = colors.panel_background.opacity(0.82);
        let panel_border = colors.border_variant.opacity(0.7);

        let (root_count, directory_count, file_count) = self.graph_counts();
        let filtered_count = self
            .graph
            .nodes
            .iter()
            .filter(|node| {
                visible_node_ids.contains(&node.id) && self.selector_filter.includes(node.kind)
            })
            .count();
        let selector_nodes = self
            .graph
            .nodes
            .iter()
            .filter(|node| {
                visible_node_ids.contains(&node.id) && self.selector_filter.includes(node.kind)
            })
            .take(MAX_SELECTOR_ROWS)
            .cloned()
            .collect::<Vec<_>>();
        let selector_hidden_count = filtered_count.saturating_sub(selector_nodes.len());

        let mut mode_buttons = h_flex().gap_1();
        for mode in JarvisLeftPanelMode::all() {
            let mode_entity = entity.clone();
            mode_buttons = mode_buttons.child(
                Button::new(("jarvis-left-mode", mode as usize), mode.label())
                    .label_size(LabelSize::XSmall)
                    .size(ButtonSize::Compact)
                    .style(ButtonStyle::Subtle)
                    .toggle_state(self.left_panel_mode == mode)
                    .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                    .start_icon(Icon::new(mode.icon()).size(IconSize::XSmall))
                    .on_click(move |_, _, cx| {
                        mode_entity.update(cx, |this, cx| {
                            this.left_panel_mode = mode;
                            if mode == JarvisLeftPanelMode::Git {
                                this.refresh_git_commits(cx);
                            }
                            cx.notify();
                        });
                    }),
            );
        }

        let mut filter_buttons = h_flex().gap_1();
        for filter in NodeSelectorFilter::all() {
            let filter_entity = entity.clone();
            filter_buttons = filter_buttons.child(
                Button::new(("jarvis-node-filter", filter as usize), filter.label())
                    .label_size(LabelSize::XSmall)
                    .size(ButtonSize::Compact)
                    .style(ButtonStyle::Subtle)
                    .toggle_state(self.selector_filter == filter)
                    .selected_style(ButtonStyle::Tinted(TintColor::Accent))
                    .start_icon(Icon::new(filter.icon()).size(IconSize::XSmall))
                    .on_click(move |_, _, cx| {
                        filter_entity.update(cx, |this, cx| {
                            this.selector_filter = filter;
                            cx.notify();
                        });
                    }),
            );
        }

        let mut selector_list = v_flex()
            .id("jarvis-selector-list")
            .gap_1()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .when(selector_nodes.is_empty(), |this| {
                this.child(
                    div().p_2().child(
                        Label::new("No nodes match this selector.")
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    ),
                )
            });

        for (ix, node) in selector_nodes.iter().enumerate() {
            let selected = self.pinned_node.as_ref() == Some(&node.id);
            let hovered = self.hovered_node.as_ref() == Some(&node.id);
            let folder_color = color_for_node(node, true, colors.text_accent, colors.text_muted);
            let row_bg = if selected {
                folder_color.opacity(0.18)
            } else if hovered {
                folder_color.opacity(0.09)
            } else {
                colors.panel_background.opacity(0.)
            };
            let row_border = if selected {
                folder_color.opacity(0.68)
            } else if hovered {
                folder_color.opacity(0.32)
            } else {
                colors.border_variant.opacity(0.)
            };
            let hover_id = node.id.clone();
            let click_id = node.id.clone();
            let hover_entity = entity.clone();
            let click_entity = entity.clone();
            let folder_child_count = self.folder_child_count(&node.id);
            let file_child_count = self.file_child_count(&node.id);
            let indent = node.depth.min(6) as f32 * 14.;
            let row_meta = if node.kind == DirectoryGraphNodeKind::File {
                "File".to_string()
            } else if self.expanded_nodes.contains(&node.id) {
                format!(
                    "{} / {} / open",
                    folder_count_label(folder_child_count),
                    file_count_label(file_child_count)
                )
            } else {
                format!(
                    "{} / {}",
                    folder_count_label(folder_child_count),
                    file_count_label(file_child_count)
                )
            };

            selector_list = selector_list.child(
                div()
                    .id(("jarvis-selector-node", ix))
                    .w_full()
                    .rounded_md()
                    .border_1()
                    .border_color(row_border)
                    .bg(row_bg)
                    .hover(move |style| style.bg(folder_color.opacity(0.11)))
                    .cursor_pointer()
                    .on_hover(move |hovered, _, cx| {
                        hover_entity.update(cx, |this, cx| {
                            if *hovered {
                                this.hovered_node = Some(hover_id.clone());
                            } else if this.hovered_node.as_ref() == Some(&hover_id) {
                                this.hovered_node = None;
                            }
                            cx.notify();
                        });
                    })
                    .on_click(move |_, _, cx| {
                        click_entity.update(cx, |this, cx| {
                            this.activate_node(click_id.clone(), cx);
                        });
                    })
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .px_2()
                            .py_1p5()
                            .pl(px(8. + indent))
                            .child(div().w(px(3.)).h(px(30.)).rounded_full().bg(
                                folder_color.opacity(
                                    if node.kind == DirectoryGraphNodeKind::File {
                                        0.22
                                    } else if node.depth == 0 {
                                        0.74
                                    } else {
                                        0.46
                                    },
                                ),
                            ))
                            .child(
                                Icon::new(kind_icon(node.kind))
                                    .size(IconSize::XSmall)
                                    .color(Color::Custom(folder_color)),
                            )
                            .child(
                                v_flex()
                                    .min_w_0()
                                    .flex_1()
                                    .gap_0p5()
                                    .child(
                                        Label::new(node.label.clone())
                                            .size(LabelSize::XSmall)
                                            .truncate(),
                                    )
                                    .child(
                                        Label::new(node.path_label.clone())
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted)
                                            .truncate(),
                                    ),
                            )
                            .child(
                                div()
                                    .px_1()
                                    .py_0p5()
                                    .rounded_sm()
                                    .border_1()
                                    .border_color(folder_color.opacity(0.24))
                                    .bg(folder_color.opacity(0.08))
                                    .child(
                                        Label::new(row_meta)
                                            .size(LabelSize::XSmall)
                                            .color(Color::Muted),
                                    ),
                            ),
                    ),
            );
        }

        if selector_hidden_count > 0 {
            selector_list = selector_list.child(
                div().px_2().py_1().child(
                    Label::new(format!("+{selector_hidden_count} more in this selector"))
                        .size(LabelSize::XSmall)
                        .color(Color::Muted),
                ),
            );
        }

        let detail_card = if let Some(node) = self.detail_node() {
            let parent_label = self
                .parent_node(&node.id)
                .map(|parent| parent.label.clone())
                .unwrap_or_else(|| "none".into());
            let folder_child_count = self.folder_child_count(&node.id);
            let file_child_count = self.file_child_count(&node.id);
            let folder_color = color_for_node(node, true, colors.text_accent, colors.text_muted);

            div()
                .w_full()
                .p_3()
                .rounded_md()
                .border_1()
                .border_color(folder_color.opacity(0.36))
                .bg(folder_color.opacity(0.08))
                .child(
                    v_flex()
                        .gap_1p5()
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(
                                    Icon::new(kind_icon(node.kind))
                                        .size(IconSize::Small)
                                        .color(Color::Custom(folder_color)),
                                )
                                .child(Label::new(node.label.clone()).size(LabelSize::Small)),
                        )
                        .child(
                            Label::new(kind_label(node.kind))
                                .size(LabelSize::XSmall)
                                .color(Color::Custom(folder_color)),
                        )
                        .child(
                            Label::new(node.path_label.clone())
                                .size(LabelSize::XSmall)
                                .color(Color::Muted)
                                .truncate(),
                        )
                        .child(
                            Label::new(if node.kind == DirectoryGraphNodeKind::File {
                                format!("Parent: {parent_label}")
                            } else {
                                format!(
                                    "Parent: {} / Subfolders: {} / Files: {}",
                                    parent_label, folder_child_count, file_child_count
                                )
                            })
                            .size(LabelSize::XSmall)
                            .color(Color::Muted)
                            .truncate(),
                        ),
                )
        } else {
            div()
                .w_full()
                .p_2()
                .rounded_md()
                .border_1()
                .border_color(panel_border)
                .bg(panel_bg)
                .child(
                    Label::new("Select a node to pin its details here.")
                        .size(LabelSize::XSmall)
                        .color(Color::Muted),
                )
        };

        let directory_content = v_flex()
            .gap_2()
            .flex_1()
            .min_h_0()
            .child(
                Label::new(format!(
                    "{} roots / {} folders / {} files / {} visible",
                    root_count, directory_count, file_count, visible_node_count
                ))
                .size(LabelSize::XSmall)
                .color(Color::Muted),
            )
            .child(filter_buttons)
            .child(selector_list)
            .child(detail_card);

        let mut git_list = v_flex()
            .id("jarvis-git-list")
            .gap_2()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .when(self.git_error.is_some(), |this| {
                this.child(
                    div()
                        .p_2()
                        .rounded_md()
                        .border_1()
                        .border_color(panel_border)
                        .child(
                            Label::new(self.git_error.clone().unwrap_or_default())
                                .size(LabelSize::XSmall)
                                .color(Color::Muted),
                        ),
                )
            })
            .when(self.git_commits.is_empty() && !self.git_loading, |this| {
                this.child(
                    div().p_2().child(
                        Label::new("No Git commits found for the active repository.")
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    ),
                )
            });

        for (ix, commit) in self.git_commits.iter().enumerate() {
            let mut changed_paths = v_flex().gap_0p5();
            if commit.changes_loading {
                changed_paths = changed_paths.child(
                    Label::new("Loading changed files...")
                        .size(LabelSize::XSmall)
                        .color(Color::Muted),
                );
            } else if commit.changed_paths.is_empty() {
                changed_paths = changed_paths.child(
                    Label::new("No changed files reported.")
                        .size(LabelSize::XSmall)
                        .color(Color::Muted),
                );
            } else {
                for path in &commit.changed_paths {
                    changed_paths = changed_paths.child(
                        h_flex()
                            .gap_1()
                            .items_center()
                            .child(Icon::new(IconName::FileDiff).size(IconSize::XSmall))
                            .child(
                                Label::new(path.clone())
                                    .size(LabelSize::XSmall)
                                    .color(Color::Muted)
                                    .truncate(),
                            ),
                    );
                }
                if commit.omitted_changed_paths > 0 {
                    changed_paths = changed_paths.child(
                        Label::new(format!("+{} more files", commit.omitted_changed_paths))
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    );
                }
            }

            git_list = git_list.child(
                v_flex()
                    .id(("jarvis-git-commit", ix))
                    .gap_1()
                    .p_2()
                    .rounded_md()
                    .border_1()
                    .border_color(panel_border)
                    .bg(panel_bg)
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(Icon::new(IconName::GitCommit).size(IconSize::XSmall))
                            .child(
                                Label::new(commit.short_sha.clone())
                                    .size(LabelSize::XSmall)
                                    .color(Color::Accent),
                            )
                            .child(
                                Label::new(commit.author.clone())
                                    .size(LabelSize::XSmall)
                                    .color(Color::Muted)
                                    .truncate(),
                            ),
                    )
                    .child(
                        Label::new(commit.subject.clone())
                            .size(LabelSize::XSmall)
                            .truncate(),
                    )
                    .child(changed_paths),
            );
        }

        let git_content = v_flex()
            .gap_2()
            .flex_1()
            .min_h_0()
            .child(
                Label::new(if self.git_loading {
                    "Loading recent commits..."
                } else {
                    "Recent commits and changed files"
                })
                .size(LabelSize::XSmall)
                .color(Color::Muted),
            )
            .child(git_list);

        let mut thread_list = v_flex()
            .id("jarvis-thread-list")
            .gap_2()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .when(self.thread_summaries.is_empty(), |this| {
                this.child(
                    div().p_2().child(
                        Label::new("No AI prompt threads yet.")
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                    ),
                )
            });

        for (ix, thread) in self
            .thread_summaries
            .iter()
            .take(MAX_THREAD_ROWS)
            .enumerate()
        {
            let mut thread_details = v_flex().gap_0p5();
            if !thread.prompt.is_empty() {
                thread_details = thread_details.child(
                    Label::new(thread.prompt.clone())
                        .size(LabelSize::XSmall)
                        .color(Color::Muted)
                        .truncate(),
                );
            }
            for path in thread.changed_paths.iter().take(5) {
                thread_details = thread_details.child(
                    h_flex()
                        .gap_1()
                        .items_center()
                        .child(Icon::new(IconName::FileDiff).size(IconSize::XSmall))
                        .child(
                            Label::new(path.clone())
                                .size(LabelSize::XSmall)
                                .color(Color::Muted)
                                .truncate(),
                        ),
                );
            }
            for event in thread.latest_events.iter().take(2) {
                thread_details = thread_details.child(
                    Label::new(event.clone())
                        .size(LabelSize::XSmall)
                        .color(Color::Muted)
                        .truncate(),
                );
            }

            thread_list = thread_list.child(
                v_flex()
                    .id(("jarvis-thread-summary", ix))
                    .gap_1()
                    .p_2()
                    .rounded_md()
                    .border_1()
                    .border_color(panel_border)
                    .bg(panel_bg)
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(Icon::new(IconName::Thread).size(IconSize::XSmall))
                            .child(
                                Label::new(thread.title.clone())
                                    .size(LabelSize::XSmall)
                                    .truncate()
                                    .flex_1(),
                            )
                            .child(
                                Label::new(thread.status.clone())
                                    .size(LabelSize::XSmall)
                                    .color(Color::Accent),
                            ),
                    )
                    .child(thread_details),
            );
        }

        let thread_content = v_flex()
            .gap_2()
            .flex_1()
            .min_h_0()
            .child(
                Label::new("AI prompts and code changes from the editor chat")
                    .size(LabelSize::XSmall)
                    .color(Color::Muted),
            )
            .child(thread_list);

        let left_content = match self.left_panel_mode {
            JarvisLeftPanelMode::Directory => directory_content.into_any_element(),
            JarvisLeftPanelMode::Git => git_content.into_any_element(),
            JarvisLeftPanelMode::Threads => thread_content.into_any_element(),
        };

        let selector_panel = v_flex()
            .h_full()
            .w(SELECTOR_PANEL_WIDTH)
            .flex_shrink_0()
            .gap_2()
            .border_r_1()
            .border_color(colors.border_variant)
            .bg(colors.panel_background)
            .p_3()
            .child(
                v_flex().gap_1().child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(Icon::new(IconName::GitGraph).size(IconSize::Small))
                        .child(Label::new("Jarvis Navigator").size(LabelSize::Small)),
                ),
            )
            .child(mode_buttons)
            .child(left_content);

        let mut graph_map = div()
            .relative()
            .h_full()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .bg(colors.editor_background);

        if self.graph.nodes.is_empty() {
            graph_map = graph_map.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        Label::new("Open a folder to visualize its directory graph.")
                            .size(LabelSize::Small)
                            .color(Color::Muted),
                    ),
            );
        } else {
            graph_map = graph_map.child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| {
                        for edge in &visible_edges {
                            let Some(parent) = positions.get(&edge.parent) else {
                                continue;
                            };
                            let Some(child) = positions.get(&edge.child) else {
                                continue;
                            };

                            let highlighted =
                                canvas_highlight_node.as_ref().is_some_and(|active_id| {
                                    &edge.parent == active_id || &edge.child == active_id
                                });
                            let parent = view_point(*parent, canvas_size, graph_zoom);
                            let child = view_point(*child, canvas_size, graph_zoom);
                            let mut path = gpui::PathBuilder::stroke(if highlighted {
                                px((1.6 * graph_zoom).max(0.85))
                            } else {
                                px((0.8 * graph_zoom).max(0.45))
                            });
                            path.move_to(bounds.origin + point(px(parent.x), px(parent.y)));
                            path.line_to(bounds.origin + point(px(child.x), px(child.y)));
                            if let Ok(path) = path.build() {
                                window.paint_path(
                                    path,
                                    if highlighted {
                                        highlighted_edge_color
                                    } else {
                                        edge_color
                                    },
                                );
                            }
                        }
                    },
                )
                .absolute()
                .inset_0(),
            );
        }

        for (ix, node) in self.graph.nodes.iter().enumerate() {
            if !visible_node_ids.contains(&node.id) {
                continue;
            }
            let Some(sim_node) = self.sim_nodes.get(&node.id) else {
                continue;
            };
            let highlighted = connected_nodes.contains(&node.id);
            let radius = radius_for_node_kind(node.kind);
            let node_radius = (radius * graph_zoom).max(MIN_NODE_RADIUS);
            let node_size = (node_radius * 2.).max(MIN_NODE_RADIUS * 2.);
            let view_position = view_point(sim_node.position, canvas_size, graph_zoom);
            let node_color =
                color_for_node(node, highlighted, colors.text_accent, colors.text_muted);
            let glow_color = node_color.opacity(if highlighted { 0.72 } else { 0.36 });
            let border_color = if highlighted {
                colors.text_accent.opacity(0.82)
            } else {
                node_color.opacity(0.56)
            };
            let node_id = node.id.clone();
            let hover_id = node.id.clone();
            let click_id = node.id.clone();
            let hover_entity = entity.clone();
            let click_entity = entity.clone();

            graph_map = graph_map.child(
                div()
                    .id(("jarvis-directory-node", ix))
                    .absolute()
                    .left(px(view_position.x - node_radius))
                    .top(px(view_position.y - node_radius))
                    .size(px(node_size))
                    .rounded_full()
                    .border_1()
                    .border_color(border_color)
                    .bg(node_color)
                    .cursor_pointer()
                    .shadow(vec![BoxShadow {
                        color: glow_color,
                        offset: point(px(0.), px(0.)),
                        blur_radius: px((if highlighted { 18. } else { 10. }) * graph_zoom),
                        spread_radius: px(if highlighted { 2. } else { 0. }),
                    }])
                    .on_hover(move |hovered, _, cx| {
                        hover_entity.update(cx, |this, cx| {
                            if *hovered {
                                this.hovered_node = Some(hover_id.clone());
                            } else if this.hovered_node.as_ref() == Some(&hover_id) {
                                this.hovered_node = None;
                            }
                            cx.notify();
                        });
                    })
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .on_click(move |_, _, cx| {
                        click_entity.update(cx, |this, cx| {
                            this.activate_node(click_id.clone(), cx);
                        });
                    }),
            );

            if should_show_graph_label(
                node,
                &node_id,
                self.hovered_node.as_ref(),
                self.pinned_node.as_ref(),
                large_graph,
            ) {
                graph_map = graph_map.child(
                    div()
                        .absolute()
                        .left(px(view_position.x + node_radius + 6.))
                        .top(px(view_position.y - 10.))
                        .max_w(px(220.))
                        .px_1()
                        .py_0p5()
                        .rounded_sm()
                        .border_1()
                        .border_color(panel_border)
                        .bg(panel_bg)
                        .child(
                            Label::new(node.label.clone())
                                .size(LabelSize::XSmall)
                                .truncate(),
                        ),
                );
            }
        }

        graph_map = graph_map.child(
            div()
                .absolute()
                .top(px(16.))
                .left(px(16.))
                .px_2()
                .py_1()
                .rounded_md()
                .border_1()
                .border_color(panel_border)
                .bg(panel_bg)
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            Label::new(format!(
                                "{} visible / {} total folders",
                                visible_node_count,
                                self.graph.nodes.len()
                            ))
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                        )
                        .child(
                            Label::new(format!(
                                "{} visible / {} folder links",
                                visible_edge_count,
                                self.graph.edges.len()
                            ))
                            .size(LabelSize::XSmall)
                            .color(Color::Muted),
                        )
                        .when(self.graph.omitted_count > 0, |this| {
                            this.child(
                                Label::new(format!("+{} omitted", self.graph.omitted_count))
                                    .size(LabelSize::XSmall)
                                    .color(Color::Accent),
                            )
                        })
                        .when(large_graph, |this| {
                            this.child(
                                Label::new("optimized")
                                    .size(LabelSize::XSmall)
                                    .color(Color::Accent),
                            )
                        }),
                ),
        );

        graph_map = graph_map.child(
            div()
                .absolute()
                .top(px(16.))
                .right(px(16.))
                .px_2()
                .py_1()
                .rounded_md()
                .border_1()
                .border_color(panel_border)
                .bg(panel_bg)
                .child(
                    h_flex()
                        .gap_2()
                        .child(legend_item(
                            "Root",
                            colors.text_accent.opacity(0.95),
                            panel_border,
                        ))
                        .child(legend_item(
                            "Directory",
                            hsla(190. / 360., 0.78, 0.62, 0.95),
                            panel_border,
                        ))
                        .child(legend_item(
                            "File",
                            colors.text_muted.opacity(0.76),
                            panel_border,
                        )),
                ),
        );

        let zoom_out_entity = entity.clone();
        let zoom_reset_entity = entity.clone();
        let zoom_in_entity = entity.clone();
        graph_map = graph_map.child(
            div()
                .absolute()
                .right(px(16.))
                .bottom(px(16.))
                .px_2()
                .py_1()
                .rounded_md()
                .border_1()
                .border_color(panel_border)
                .bg(panel_bg)
                .child(
                    h_flex()
                        .gap_1()
                        .items_center()
                        .child(
                            IconButton::new("jarvis-zoom-out", IconName::Dash)
                                .icon_size(IconSize::XSmall)
                                .tooltip(Tooltip::text("Zoom out"))
                                .on_click(move |_, _, cx| {
                                    zoom_out_entity.update(cx, |this, cx| {
                                        let zoom = this.graph_zoom - GRAPH_ZOOM_STEP;
                                        this.set_graph_zoom(zoom, cx);
                                    });
                                }),
                        )
                        .child(
                            Button::new(
                                "jarvis-zoom-reset",
                                format!("{}%", (self.graph_zoom * 100.).round() as i32),
                            )
                            .label_size(LabelSize::XSmall)
                            .size(ButtonSize::Compact)
                            .style(ButtonStyle::Subtle)
                            .tooltip(Tooltip::text("Reset zoom"))
                            .on_click(move |_, _, cx| {
                                zoom_reset_entity.update(cx, |this, cx| {
                                    this.set_graph_zoom(DEFAULT_GRAPH_ZOOM, cx);
                                });
                            }),
                        )
                        .child(
                            IconButton::new("jarvis-zoom-in", IconName::Plus)
                                .icon_size(IconSize::XSmall)
                                .tooltip(Tooltip::text("Zoom in"))
                                .on_click(move |_, _, cx| {
                                    zoom_in_entity.update(cx, |this, cx| {
                                        let zoom = this.graph_zoom + GRAPH_ZOOM_STEP;
                                        this.set_graph_zoom(zoom, cx);
                                    });
                                }),
                        ),
                ),
        );

        if let Some(node) = self.detail_node() {
            graph_map = graph_map.child(
                div()
                    .absolute()
                    .left(px(16.))
                    .bottom(px(16.))
                    .w(px(320.))
                    .p_3()
                    .rounded_md()
                    .border_1()
                    .border_color(panel_border)
                    .bg(panel_bg)
                    .child(
                        v_flex()
                            .gap_1()
                            .child(Label::new(node.label.clone()).size(LabelSize::Small))
                            .child(
                                Label::new(kind_label(node.kind))
                                    .size(LabelSize::XSmall)
                                    .color(Color::Accent),
                            )
                            .child(
                                Label::new(node.path_label.clone())
                                    .size(LabelSize::XSmall)
                                    .color(Color::Muted)
                                    .truncate(),
                            ),
                    ),
            );
        }

        let chat_panel = v_flex()
            .h_full()
            .w(CHAT_PANEL_WIDTH)
            .flex_shrink_0()
            .border_l_1()
            .border_color(colors.border_variant)
            .bg(colors.editor_background)
            .child(match self.chat_view.clone() {
                Some(chat_view) => div()
                    .size_full()
                    .overflow_hidden()
                    .child(chat_view)
                    .into_any_element(),
                None => v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .p_4()
                    .child(Icon::new(IconName::Chat).size(IconSize::XLarge))
                    .child(Label::new("Editor chat is loading.").size(LabelSize::Small))
                    .child(
                        Label::new(
                            "The Jarvis tab uses the same Agent Panel chat as the code editor.",
                        )
                        .size(LabelSize::XSmall)
                        .color(Color::Muted),
                    )
                    .into_any_element(),
            });

        h_flex()
            .id("jarvis-directory-visualizer")
            .key_context("JarvisDirectoryVisualizer")
            .size_full()
            .overflow_hidden()
            .bg(colors.editor_background)
            .child(selector_panel)
            .child(graph_map)
            .child(chat_panel)
    }
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn kind_label(kind: DirectoryGraphNodeKind) -> &'static str {
    match kind {
        DirectoryGraphNodeKind::Root => "Workspace root",
        DirectoryGraphNodeKind::Directory => "Directory",
        DirectoryGraphNodeKind::File => "File",
    }
}

fn kind_icon(kind: DirectoryGraphNodeKind) -> IconName {
    match kind {
        DirectoryGraphNodeKind::Root => IconName::GitWorktree,
        DirectoryGraphNodeKind::Directory => IconName::Folder,
        DirectoryGraphNodeKind::File => IconName::File,
    }
}

fn folder_count_label(count: usize) -> String {
    match count {
        0 => "No subfolders".to_string(),
        1 => "1 folder".to_string(),
        count => format!("{count} folders"),
    }
}

fn file_count_label(count: usize) -> String {
    match count {
        0 => "No files".to_string(),
        1 => "1 file".to_string(),
        count => format!("{count} files"),
    }
}

fn legend_item(label: &'static str, color: Hsla, border_color: Hsla) -> impl IntoElement {
    h_flex()
        .gap_1()
        .items_center()
        .child(
            div()
                .size(px(7.))
                .rounded_full()
                .border_1()
                .border_color(border_color)
                .bg(color),
        )
        .child(
            Label::new(label)
                .size(LabelSize::XSmall)
                .color(Color::Muted),
        )
}

fn radius_for_node_kind(kind: DirectoryGraphNodeKind) -> f32 {
    match kind {
        DirectoryGraphNodeKind::Root => ROOT_NODE_RADIUS,
        DirectoryGraphNodeKind::Directory => DIRECTORY_NODE_RADIUS,
        DirectoryGraphNodeKind::File => FILE_NODE_RADIUS,
    }
}

fn color_for_node(node: &DirectoryGraphNode, highlighted: bool, accent: Hsla, muted: Hsla) -> Hsla {
    let alpha = if highlighted { 0.95 } else { 0.72 };
    match node.kind {
        DirectoryGraphNodeKind::Root => hsla(46. / 360., 0.92, 0.62, alpha),
        DirectoryGraphNodeKind::Directory => match node.depth % 4 {
            0 => accent.opacity(alpha),
            1 => hsla(205. / 360., 0.9, 0.66, alpha),
            2 => hsla(158. / 360., 0.72, 0.58, alpha),
            _ => hsla(286. / 360., 0.72, 0.68, alpha),
        },
        DirectoryGraphNodeKind::File => muted.opacity(if highlighted { 0.86 } else { 0.52 }),
    }
}

fn view_point(point: GraphPoint, canvas_size: Size<Pixels>, zoom: f32) -> GraphPoint {
    let width = f32::from(canvas_size.width).max(320.);
    let height = f32::from(canvas_size.height).max(240.);
    let center = GraphPoint::new(width / 2., height / 2.);

    GraphPoint::new(
        center.x + (point.x - center.x) * zoom,
        center.y + (point.y - center.y) * zoom,
    )
}

fn should_show_graph_label(
    node: &DirectoryGraphNode,
    node_id: &DirectoryGraphNodeId,
    hovered_node: Option<&DirectoryGraphNodeId>,
    pinned_node: Option<&DirectoryGraphNodeId>,
    large_graph: bool,
) -> bool {
    node.kind == DirectoryGraphNodeKind::Root
        || hovered_node == Some(node_id)
        || pinned_node == Some(node_id)
        || (!large_graph && node.kind == DirectoryGraphNodeKind::Directory)
}

fn visible_node_ids_for_graph(
    graph: &DirectoryGraph,
    expanded_nodes: &HashSet<DirectoryGraphNodeId>,
) -> HashSet<DirectoryGraphNodeId> {
    let parent_ids = graph
        .edges
        .iter()
        .map(|edge| (edge.child.clone(), edge.parent.clone()))
        .collect::<HashMap<_, _>>();

    graph
        .nodes
        .iter()
        .filter(|node| {
            node.kind != DirectoryGraphNodeKind::File
                || parent_ids
                    .get(&node.id)
                    .is_some_and(|parent_id| expanded_nodes.contains(parent_id))
        })
        .map(|node| node.id.clone())
        .collect()
}

fn build_graph_from_project(project: &Entity<Project>, cx: &App) -> DirectoryGraph {
    let project = project.read(cx);
    let worktrees = project
        .visible_worktrees(cx)
        .map(|worktree| {
            let worktree = worktree.read(cx);
            let snapshot = worktree.snapshot();
            DirectoryGraphWorktreeInput {
                worktree_id: snapshot.id(),
                root_name: snapshot.root_name_str().to_string().into(),
                entries: snapshot
                    .entries(true, 0)
                    .filter(|entry| {
                        !entry.path.is_empty()
                            && !entry.is_ignored
                            && entry.path.components().count() <= DEFAULT_MAX_DEPTH
                    })
                    .map(|entry| DirectoryGraphEntryInput {
                        path: entry.path.clone(),
                        is_dir: entry.is_dir(),
                        is_ignored: entry.is_ignored,
                    })
                    .collect(),
            }
        })
        .collect::<Vec<_>>();

    build_graph_from_worktree_entries(worktrees, DEFAULT_MAX_DEPTH, MAX_GRAPH_NODES)
}

pub(crate) fn build_graph_from_worktree_entries(
    worktrees: Vec<DirectoryGraphWorktreeInput>,
    max_depth: usize,
    max_nodes: usize,
) -> DirectoryGraph {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut inserted_ids: HashSet<DirectoryGraphNodeId> = HashSet::default();
    let mut omitted_count = 0;

    for worktree in &worktrees {
        let root_id = DirectoryGraphNodeId::root(worktree.worktree_id);
        if nodes.len() < max_nodes {
            inserted_ids.insert(root_id.clone());
            nodes.push(DirectoryGraphNode {
                id: root_id,
                label: worktree.root_name.clone(),
                path_label: worktree.root_name.clone(),
                kind: DirectoryGraphNodeKind::Root,
                depth: 0,
            });
        } else {
            omitted_count += 1;
        }
    }

    for worktree in worktrees {
        let mut entries = worktree
            .entries
            .into_iter()
            .filter(|entry| {
                !entry.is_ignored
                    && !entry.path.is_empty()
                    && entry.path.components().count() <= max_depth
            })
            .collect::<Vec<_>>();

        entries.sort_by(|left, right| {
            right
                .is_dir
                .cmp(&left.is_dir)
                .then_with(|| left.path.as_unix_str().cmp(right.path.as_unix_str()))
        });

        for entry in entries {
            if nodes.len() >= max_nodes {
                omitted_count += 1;
                continue;
            }

            let id = DirectoryGraphNodeId::new(worktree.worktree_id, entry.path.clone());
            let parent_path = entry
                .path
                .parent()
                .map(RelPath::into_arc)
                .unwrap_or_else(|| RelPath::empty().into_arc());
            let parent_id = DirectoryGraphNodeId::new(worktree.worktree_id, parent_path);
            let label = entry
                .path
                .file_name()
                .unwrap_or_else(|| entry.path.as_unix_str())
                .to_string();
            let depth = entry.path.components().count();

            inserted_ids.insert(id.clone());
            if inserted_ids.contains(&parent_id) {
                edges.push(DirectoryGraphEdge {
                    parent: parent_id,
                    child: id.clone(),
                });
            }

            nodes.push(DirectoryGraphNode {
                id,
                label: label.into(),
                path_label: entry.path.as_unix_str().to_string().into(),
                kind: if entry.is_dir {
                    DirectoryGraphNodeKind::Directory
                } else {
                    DirectoryGraphNodeKind::File
                },
                depth,
            });
        }
    }

    DirectoryGraph {
        nodes,
        edges,
        omitted_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel_path(path: &str) -> Arc<RelPath> {
        if path.is_empty() {
            RelPath::empty().into_arc()
        } else {
            RelPath::unix(path).unwrap().into_arc()
        }
    }

    fn entry(path: &str, is_dir: bool, is_ignored: bool) -> DirectoryGraphEntryInput {
        DirectoryGraphEntryInput {
            path: rel_path(path),
            is_dir,
            is_ignored,
        }
    }

    fn worktree(entries: Vec<DirectoryGraphEntryInput>) -> DirectoryGraphWorktreeInput {
        DirectoryGraphWorktreeInput {
            worktree_id: WorktreeId::from_usize(1),
            root_name: "root".into(),
            entries,
        }
    }

    fn contains_path(graph: &DirectoryGraph, path: &str) -> bool {
        let path = rel_path(path);
        graph.nodes.iter().any(|node| node.id.path == path)
    }

    fn visible_contains(visible_node_ids: &HashSet<DirectoryGraphNodeId>, path: &str) -> bool {
        visible_node_ids.contains(&DirectoryGraphNodeId::new(
            WorktreeId::from_usize(1),
            rel_path(path),
        ))
    }

    #[test]
    fn graph_includes_worktree_root() {
        let graph = build_graph_from_worktree_entries(
            vec![worktree(vec![entry("src", true, false)])],
            3,
            250,
        );

        assert_eq!(graph.nodes[0].kind, DirectoryGraphNodeKind::Root);
        assert_eq!(graph.nodes[0].label.as_ref(), "root");
        assert!(contains_path(&graph, "src"));
    }

    #[test]
    fn graph_caps_depth_to_top_three_levels() {
        let graph = build_graph_from_worktree_entries(
            vec![worktree(vec![
                entry("a", true, false),
                entry("a/b", true, false),
                entry("a/b/c", true, false),
                entry("a/b/c/d.rs", false, false),
            ])],
            3,
            250,
        );

        assert!(contains_path(&graph, "a"));
        assert!(contains_path(&graph, "a/b"));
        assert!(contains_path(&graph, "a/b/c"));
        assert!(!contains_path(&graph, "a/b/c/d.rs"));
    }

    #[test]
    fn graph_excludes_ignored_entries() {
        let graph = build_graph_from_worktree_entries(
            vec![worktree(vec![
                entry(".gitignore", false, false),
                entry("src", true, false),
                entry("target", true, true),
                entry("target/debug.log", false, true),
            ])],
            3,
            250,
        );

        assert!(contains_path(&graph, ".gitignore"));
        assert!(contains_path(&graph, "src"));
        assert!(!contains_path(&graph, "target"));
        assert!(!contains_path(&graph, "target/debug.log"));
    }

    #[test]
    fn graph_generates_parent_child_edges() {
        let graph = build_graph_from_worktree_entries(
            vec![worktree(vec![
                entry("src", true, false),
                entry("src/main.rs", false, false),
            ])],
            3,
            250,
        );
        let root = DirectoryGraphNodeId::root(WorktreeId::from_usize(1));
        let src = DirectoryGraphNodeId::new(WorktreeId::from_usize(1), rel_path("src"));
        let main = DirectoryGraphNodeId::new(WorktreeId::from_usize(1), rel_path("src/main.rs"));

        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.parent == root && edge.child == src)
        );
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.parent == src && edge.child == main)
        );
    }

    #[test]
    fn graph_reports_omitted_entries_when_capped() {
        let graph = build_graph_from_worktree_entries(
            vec![worktree(vec![
                entry("a", true, false),
                entry("b", true, false),
                entry("c", true, false),
                entry("d", true, false),
            ])],
            3,
            3,
        );

        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.omitted_count, 2);
    }

    #[test]
    fn graph_visibility_shows_roots_folders_and_subfolders() {
        let graph = build_graph_from_worktree_entries(
            vec![worktree(vec![
                entry("README.md", false, false),
                entry("src", true, false),
                entry("src/nested", true, false),
                entry("src/main.rs", false, false),
            ])],
            3,
            250,
        );
        let visible_node_ids = visible_node_ids_for_graph(&graph, &HashSet::default());

        assert!(visible_node_ids.contains(&DirectoryGraphNodeId::root(WorktreeId::from_usize(1))));
        assert!(visible_contains(&visible_node_ids, "src"));
        assert!(visible_contains(&visible_node_ids, "src/nested"));
        assert!(!visible_contains(&visible_node_ids, "README.md"));
        assert!(!visible_contains(&visible_node_ids, "src/main.rs"));
    }

    #[test]
    fn graph_visibility_shows_direct_files_after_folder_expansion() {
        let graph = build_graph_from_worktree_entries(
            vec![worktree(vec![
                entry("README.md", false, false),
                entry("src", true, false),
                entry("src/nested", true, false),
                entry("src/main.rs", false, false),
            ])],
            3,
            250,
        );
        let mut expanded_nodes = HashSet::default();
        expanded_nodes.insert(DirectoryGraphNodeId::new(
            WorktreeId::from_usize(1),
            rel_path("src"),
        ));
        let visible_node_ids = visible_node_ids_for_graph(&graph, &expanded_nodes);

        assert!(visible_contains(&visible_node_ids, "src"));
        assert!(visible_contains(&visible_node_ids, "src/nested"));
        assert!(visible_contains(&visible_node_ids, "src/main.rs"));
        assert!(!visible_contains(&visible_node_ids, "README.md"));
    }

    #[test]
    fn graph_zoom_scales_points_around_canvas_center() {
        let point = view_point(GraphPoint::new(300., 40.), size(px(400.), px(240.)), 0.5);

        assert_eq!(point.x, 250.);
        assert_eq!(point.y, 80.);
    }
}
