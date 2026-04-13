import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../App'
import CrewNav from '../../components/CrewNav'
import usePendingCounts from '../../hooks/usePendingCounts'
import ConfirmModal from '../../components/ConfirmModal'
import MessageModal from '../../components/MessageModal'
import EventEditModal from '../../components/EventEditModal'
import ActionMenu from '../../components/ActionMenu'
import AutoGrowTextarea from '../../components/AutoGrowTextarea'
import EmptyState from '../../components/EmptyState'
import { parseLocalDate, formatShortDate, formatLongDate, getMonth, getDayOfMonth } from '../../utils/dateUtils'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

const STATUS_FLOW = ['planning', 'finalized', 'printed', 'distributed']

const ISSUE_TYPES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'biweekly', label: 'Bi-weekly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'special', label: 'Special' }
]

// Build authenticated upload URL (server requires token for /uploads)
const getUploadUrl = (filename) => `/uploads/${filename}?token=${localStorage.getItem('token')}`

// Check if PSD has a generated preview
const getPsdPreview = (filename) => {
  if (filename.toLowerCase().endsWith('.psd')) {
    return filename.replace(/\.psd$/i, '_preview.png')
  }
  return null
}

// Helper to convert 24hr time to 12hr format
const formatTime12hr = (time) => {
  if (!time) return ''
  const [hours, minutes] = time.split(':')
  const h = parseInt(hours, 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 || 12
  return `${hour12}:${minutes} ${ampm}`
}

// Helper to generate defaults based on issue type
const getDefaultsForType = (type) => {
  const today = new Date()
  let startDate, endDate, name

  switch (type) {
    case 'monthly': {
      const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
      const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0)
      startDate = firstOfMonth.toISOString().split('T')[0]
      endDate = lastOfMonth.toISOString().split('T')[0]
      name = `${MONTHS[today.getMonth()]} ${today.getFullYear()}`
      break
    }
    case 'biweekly': {
      startDate = today.toISOString().split('T')[0]
      const twoWeeksLater = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000)
      endDate = twoWeeksLater.toISOString().split('T')[0]
      name = `Week of ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      break
    }
    case 'weekly': {
      startDate = today.toISOString().split('T')[0]
      const oneWeekLater = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
      endDate = oneWeekLater.toISOString().split('T')[0]
      // Calculate week number
      const startOfYear = new Date(today.getFullYear(), 0, 1)
      const weekNum = Math.ceil(((today - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7)
      name = `Week ${weekNum} - ${today.getFullYear()}`
      break
    }
    case 'special':
    default: {
      startDate = today.toISOString().split('T')[0]
      endDate = today.toISOString().split('T')[0]
      name = ''
      break
    }
  }

  return { startDate, endDate, name }
}

// Inventory stats grid component
function InventoryStats({ inventory }) {
  if (!inventory || inventory.total_printed === 0) return null

  // Check if demand exceeds supply
  const needsMore = inventory.pending_requested > inventory.remaining
  const shortfall = inventory.pending_requested - inventory.remaining

  return (
    <>
      <div className="inventory-grid">
        <div className="inventory-card">
          <span className="inventory-value inventory-printed">{inventory.total_printed}</span>
          <span className="inventory-label">printed</span>
        </div>
        <div className="inventory-card">
          <span className="inventory-value inventory-delivered">{inventory.total_delivered}</span>
          <span className="inventory-label">delivered</span>
        </div>
        <div className="inventory-card">
          <span className={`inventory-value inventory-remaining${inventory.remaining < 50 ? ' inventory-low' : ''}`}>
            {inventory.remaining}
          </span>
          <span className="inventory-label">remaining</span>
        </div>
        <div className="inventory-card">
          <span className={`inventory-value inventory-requested${needsMore ? ' inventory-warning-value' : ''}`}>
            {inventory.pending_requested || 0}
          </span>
          <span className="inventory-label">requested</span>
        </div>
      </div>
      {needsMore && (
        <div className="inventory-warning">
          Running low - {shortfall} more cards needed to fulfill pending requests
        </div>
      )}
    </>
  )
}

// Print runs section component
function PrintRunsSection({ issueId, issueName, issueStatus, printRuns, onUpdate, api, isEditable, autoOpenReceiveId }) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingRun, setEditingRun] = useState(null)
  const [receivingRun, setReceivingRun] = useState(null)
  const [receivedQty, setReceivedQty] = useState('')
  const [hasAutoOpened, setHasAutoOpened] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [errorModal, setErrorModal] = useState(null)
  const [statusConfirm, setStatusConfirm] = useState(false)
  const [form, setForm] = useState({
    quantity_ordered: '',
    quantity_received: '',
    unit_cost: '',
    vendor: '',
    order_date: new Date().toISOString().split('T')[0],
    expected_date: '',
    notes: ''
  })
  const [loading, setLoading] = useState(false)

  const resetForm = () => {
    setForm({
      quantity_ordered: '',
      quantity_received: '',
      unit_cost: '',
      vendor: '',
      order_date: new Date().toISOString().split('T')[0],
      expected_date: '',
      notes: ''
    })
    setShowAddForm(false)
    setEditingRun(null)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const payload = {
        quantity_ordered: parseInt(form.quantity_ordered),
        quantity_received: form.quantity_received ? parseInt(form.quantity_received) : 0,
        unit_cost: form.unit_cost ? parseFloat(form.unit_cost) : null,
        vendor: form.vendor || null,
        order_date: form.order_date || null,
        expected_date: form.expected_date || null,
        notes: form.notes || null
      }

      if (editingRun) {
        await api(`/issues/${issueId}/print-runs/${editingRun.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload)
        })
      } else {
        await api(`/issues/${issueId}/print-runs`, {
          method: 'POST',
          body: JSON.stringify(payload)
        })
      }
      resetForm()
      onUpdate()
    } catch (err) {
      console.error(err)
      resetForm()  // Close form modal first so error modal is visible
      setErrorModal(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (run) => {
    setForm({
      quantity_ordered: run.quantity_ordered.toString(),
      quantity_received: run.quantity_received?.toString() || '',
      unit_cost: run.unit_cost?.toString() || '',
      vendor: run.vendor || '',
      order_date: run.order_date || '',
      expected_date: run.expected_date || '',
      notes: run.notes || ''
    })
    setEditingRun(run)
    setShowAddForm(true)
  }

  const openReceiveModal = (run) => {
    setReceivingRun(run)
    // Default to REMAINING amount, not full ordered
    const remaining = run.quantity_ordered - (run.quantity_received || 0)
    setReceivedQty(remaining.toString())
  }

  // Auto-open receive modal if specified via URL param
  useEffect(() => {
    if (autoOpenReceiveId && printRuns.length > 0 && !hasAutoOpened) {
      const targetRun = printRuns.find(r => r.id === autoOpenReceiveId)
      if (targetRun && targetRun.quantity_received < targetRun.quantity_ordered) {
        openReceiveModal(targetRun)
        setHasAutoOpened(true)
      }
    }
  }, [autoOpenReceiveId, printRuns, hasAutoOpened])

  const handleMarkReceived = async () => {
    if (!receivingRun) return
    const qty = parseInt(receivedQty)
    if (isNaN(qty) || qty < 0) {
      setErrorModal('Please enter a valid quantity')
      return
    }

    setLoading(true)
    try {
      await api(`/issues/${issueId}/print-runs/${receivingRun.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          quantity_received_add: qty,  // ADDITIVE - adds to existing
          received_date: new Date().toISOString().split('T')[0]
        })
      })
      setReceivingRun(null)
      setReceivedQty('')

      // If issue is finalized and we just received cards, offer to advance status
      if (issueStatus === 'finalized' && qty > 0) {
        setStatusConfirm(true)
      } else {
        onUpdate()
      }
    } catch (err) {
      setErrorModal(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleAdvanceStatus = async () => {
    setStatusConfirm(false)
    try {
      await api(`/issues/${issueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'printed' })
      })
    } catch (statusErr) {
      setErrorModal('Failed to advance status: ' + statusErr.message)
    }
    onUpdate()
  }

  const handleSkipAdvance = () => {
    setStatusConfirm(false)
    onUpdate()
  }

  const handleDelete = async (runId) => {
    try {
      await api(`/issues/${issueId}/print-runs/${runId}`, { method: 'DELETE' })
      setDeleteConfirm(null)
      onUpdate()
    } catch (err) {
      setDeleteConfirm(null)
      setErrorModal(err.message)
    }
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return ''
    const d = parseLocalDate(dateStr)
    return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
  }

  return (
    <div className="print-runs-section">
      <div className="print-runs-header">
        <h4>Print Runs</h4>
        {isEditable && !showAddForm && (
          <button className="btn btn-small" onClick={() => setShowAddForm(true)}>
            + Add Print Run
          </button>
        )}
      </div>

      {/* Add/Edit Print Run Modal */}
      {showAddForm && createPortal(
        <div className="modal-overlay" onClick={resetForm}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <h3 className="card-title">{editingRun ? 'Edit Print Run' : 'Add Print Run'}</h3>
            <form onSubmit={handleSubmit}>
              <div className="form-row-2">
                <div className="form-group">
                  <label className="form-label">Quantity Ordered *</label>
                  <input
                    type="number"
                    className="form-input"
                    value={form.quantity_ordered}
                    onChange={e => setForm({ ...form, quantity_ordered: e.target.value })}
                    required
                    min="1"
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Quantity Received</label>
                  <input
                    type="number"
                    className="form-input"
                    value={form.quantity_received}
                    onChange={e => setForm({ ...form, quantity_received: e.target.value })}
                    min="0"
                  />
                </div>
              </div>
              <div className="form-row-2">
                <div className="form-group">
                  <label className="form-label">Unit Cost ($)</label>
                  <input
                    type="number"
                    className="form-input"
                    value={form.unit_cost}
                    onChange={e => setForm({ ...form, unit_cost: e.target.value })}
                    step="0.01"
                    min="0"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Vendor</label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.vendor}
                    onChange={e => setForm({ ...form, vendor: e.target.value })}
                    placeholder="Printer name"
                  />
                </div>
              </div>
              <div className="form-row-2">
                <div className="form-group">
                  <label className="form-label">Order Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={form.order_date}
                    onChange={e => setForm({ ...form, order_date: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Expected Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={form.expected_date}
                    onChange={e => setForm({ ...form, expected_date: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <input
                  type="text"
                  className="form-input"
                  value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  placeholder="Optional notes"
                />
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
                <button type="submit" className="btn btn-primary" disabled={loading}>
                  {loading ? 'Saving...' : (editingRun ? 'Update' : 'Add Print Run')}
                </button>
                <button type="button" className="btn" onClick={resetForm}>Cancel</button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      <div className="print-runs-list">
        {printRuns.length === 0 ? (
          <div className="empty-state">No print runs yet</div>
        ) : (
          printRuns.map((run, idx) => (
            <div key={run.id} className="print-run-item">
              <div className="print-run-row">
                <div className="print-run-content">
                  <div className="print-run-main">
                    <span className="print-run-number">#{printRuns.length - idx}</span>
                    <span className="print-run-qty">
                      {run.quantity_ordered} ordered
                      {run.quantity_received > 0 && (
                        <span className="print-run-received"> → {run.quantity_received} received</span>
                      )}
                    </span>
                    {run.unit_cost && (
                      <span className="print-run-cost">(${run.unit_cost.toFixed(2)}/ea)</span>
                    )}
                  </div>
                  <div className="print-run-details">
                    {run.vendor && <span className="print-run-vendor">{run.vendor}</span>}
                    {run.order_date && <span>Ordered {formatDate(run.order_date)}</span>}
                    {run.expected_date && !run.received_date && <span>Expected {formatDate(run.expected_date)}</span>}
                    {run.received_date && <span>Received {formatDate(run.received_date)}</span>}
                  </div>
                </div>
                {isEditable && (
                  <ActionMenu
                    compact
                    actions={[
                      { label: 'Edit', onClick: () => handleEdit(run) },
                      { label: 'Delete', onClick: () => setDeleteConfirm(run), danger: true }
                    ]}
                  />
                )}
              </div>
              {isEditable && run.quantity_received < run.quantity_ordered && (
                <div className="print-run-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => openReceiveModal(run)}
                  >
                    Mark Received
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Delete Print Run Confirm */}
      {deleteConfirm && (
        <ConfirmModal
          title="Delete Print Run"
          message={`Delete print run #${deleteConfirm.id} (${deleteConfirm.quantity_ordered} ordered)?`}
          confirmText="Delete"
          onConfirm={() => handleDelete(deleteConfirm.id)}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {/* Mark Received Modal */}
      {receivingRun && createPortal(
        <div className="modal-overlay" onClick={() => { setReceivingRun(null); setReceivedQty(''); }}>
          <div className="modal card modal-sm" onClick={e => e.stopPropagation()}>
            <h3 className="card-title">Receive Cards for {issueName}</h3>

            <div style={{ marginBottom: 'var(--space-md)', opacity: 0.8 }}>
              <div>Ordered: <strong>{receivingRun.quantity_ordered}</strong> cards</div>
              {receivingRun.quantity_received > 0 && (
                <div>Already received: <strong>{receivingRun.quantity_received}</strong> cards</div>
              )}
              <div>Remaining: <strong>{receivingRun.quantity_ordered - (receivingRun.quantity_received || 0)}</strong> cards</div>
              {receivingRun.vendor && <div>Vendor: {receivingRun.vendor}</div>}
            </div>

            <div className="form-group">
              <label className="form-label">
                {receivingRun.quantity_received > 0 ? 'How many MORE cards received?' : 'How many cards received?'}
              </label>
              <input
                type="number"
                className="form-input"
                value={receivedQty}
                onChange={e => setReceivedQty(e.target.value)}
                min="1"
                autoFocus
              />
              <small style={{ opacity: 0.7 }}>
                {receivingRun.quantity_received > 0
                  ? `Will add to existing ${receivingRun.quantity_received} for new total`
                  : 'Enter how many cards arrived in this shipment'}
              </small>
            </div>

            <div className="modal-actions">
              <button
                className="btn btn-primary"
                onClick={handleMarkReceived}
                disabled={loading || !receivedQty}
                style={{ flex: 1 }}
              >
                {loading ? 'Saving...' : 'Confirm Received'}
              </button>
              <button
                className="btn"
                onClick={() => { setReceivingRun(null); setReceivedQty(''); }}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Status Advance Confirmation Modal */}
      {statusConfirm && (
        <ConfirmModal
          title="Advance Issue Status"
          message="Cards received! Move issue to 'Printed' status?"
          confirmLabel="Yes, Mark as Printed"
          onConfirm={handleAdvanceStatus}
          onCancel={handleSkipAdvance}
        />
      )}

      {/* Error Modal - topLayer so it appears above other modals */}
      {errorModal && (
        <MessageModal
          title="Error"
          message={errorModal}
          type="error"
          onClose={() => setErrorModal(null)}
          topLayer
        />
      )}
    </div>
  )
}

// Sortable event item component - Compact layout
function SortableEventItem({ event, onRemove, onEdit, onMove, isEditable, isFirst, isLast }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: event.id, disabled: !isEditable })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const eventDate = parseLocalDate(event.event_date)
  const month = eventDate ? eventDate.getMonth() + 1 : null
  const day = eventDate ? eventDate.getDate() : null

  // Show artists only if different from event_name and event_name exists
  const showArtists = event.artists &&
    event.artists !== event.event_name &&
    event.event_name

  // Build action menu items
  const actions = [
    { label: 'Edit', onClick: () => onEdit(event) },
    { label: 'Remove', onClick: () => onRemove(event.id), danger: true }
  ]

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`sortable-event${isEditable ? ' draggable' : ''}`}
      {...(isEditable ? { ...attributes, ...listeners } : {})}
    >
      {isEditable && (
        <div className="drag-handle">
          ⋮⋮
        </div>
      )}
      <div className="event-date-compact">{month}/{day}</div>
      <div className="sortable-event-details">
        <div className="event-name">
          {event.event_name || event.artists}
        </div>
        <div className="event-venue">
          {event.venue_name || event.venue_name_raw}
          {event.event_time && ` @ ${formatTime12hr(event.event_time)}`}
        </div>
        {showArtists && (
          <div className="event-artists">{event.artists}</div>
        )}
      </div>
      {isEditable && (
        <ActionMenu compact actions={actions} />
      )}
    </div>
  )
}

// Status timeline component
function StatusTimeline({ currentStatus }) {
  return (
    <div className="status-timeline">
      {STATUS_FLOW.map((status, index) => {
        const currentIndex = STATUS_FLOW.indexOf(currentStatus)
        const isComplete = index < currentIndex
        const isCurrent = index === currentIndex

        return (
          <div key={status} className="status-step">
            <div
              className={`status-dot ${isComplete ? 'complete' : ''} ${isCurrent ? 'current' : ''}`}
            />
            <span className={`status-label ${isCurrent ? 'current' : ''}`}>
              {status}
            </span>
            {index < STATUS_FLOW.length - 1 && (
              <div className={`status-line ${isComplete ? 'complete' : ''}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}


// Quick assign panel component - unified row style with selected events
function QuickAssignPanel({ unassignedEvents, onAssign, isFull }) {
  const [addingId, setAddingId] = useState(null)

  // Sort by date (flat list, no grouping)
  const sortedEvents = useMemo(() => {
    return [...unassignedEvents].sort((a, b) => a.event_date.localeCompare(b.event_date))
  }, [unassignedEvents])

  // Handle tap-to-add with green flash feedback
  const handleAdd = (eventId) => {
    if (isFull || addingId) return
    setAddingId(eventId)
    setTimeout(() => {
      onAssign(eventId)
      setAddingId(null)
    }, 200) // Brief flash before removing
  }

  return (
    <div className="quick-assign-panel">
      <h4 className="panel-title">Approved Events in Date Range ({unassignedEvents.length})</h4>
      {isFull && (
        <div className="message message-info" style={{ marginBottom: 'var(--space-md)' }}>
          This issue has reached its max event limit. Remove events above to add more.
        </div>
      )}
      <div className="quick-assign-list">
        {sortedEvents.length === 0 ? (
          <div className="empty-state">No unassigned approved events</div>
        ) : (
          sortedEvents.map(event => {
            const eventDate = parseLocalDate(event.event_date)
            const month = eventDate ? eventDate.getMonth() + 1 : null
            const day = eventDate ? eventDate.getDate() : null
            const showArtists = event.artists &&
              event.artists !== event.event_name &&
              event.event_name

            return (
              <div
                key={event.id}
                className={`quick-assign-event ${isFull ? 'disabled' : ''} ${addingId === event.id ? 'adding' : ''}`}
                onClick={() => handleAdd(event.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleAdd(event.id)}
                title={isFull ? 'Issue is at max capacity' : 'Click to add to issue'}
              >
                <div className="event-date-compact">{month}/{day}</div>
                <div className="quick-assign-event-info">
                  <div className="event-name">
                    {event.event_name || event.artists}
                  </div>
                  <div className="event-venue">
                    {event.venue_name || event.venue_name_raw}
                    {event.event_time && ` @ ${formatTime12hr(event.event_time)}`}
                  </div>
                  {showArtists && (
                    <div className="event-artists">{event.artists}</div>
                  )}
                </div>
                <span className="add-hint">+</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export default function CrewIssues() {
  const { api } = useAuth()
  const { counts } = usePendingCounts()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [issues, setIssues] = useState([])
  const [allEvents, setAllEvents] = useState([])
  const [artSubmissions, setArtSubmissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedIssue, setSelectedIssue] = useState(null)
  const [issueEvents, setIssueEvents] = useState([])
  const [printRuns, setPrintRuns] = useState([])
  const [inventory, setInventory] = useState(null)
  const [showArtPicker, setShowArtPicker] = useState(false)
  const [showFinalizeModal, setShowFinalizeModal] = useState(false)
  const [finalizeForm, setFinalizeForm] = useState({ print_deadline: '' })
  const [form, setForm] = useState(() => {
    const defaults = getDefaultsForType('monthly')
    return {
      issue_type: 'monthly',
      name: defaults.name,
      start_date: defaults.startDate,
      end_date: defaults.endDate,
      notes: '',
      max_events: 10
    }
  })
  const [message, setMessage] = useState(null)
  const [deleteModal, setDeleteModal] = useState(null)
  const [errorModal, setErrorModal] = useState(null)
  const [activateModal, setActivateModal] = useState(null)
  const [activatePreview, setActivatePreview] = useState(null)
  const [closeModal, setCloseModal] = useState(null)
  const [closeForm, setCloseForm] = useState({ write_off_reason: '' })
  const [revertModal, setRevertModal] = useState(null) // { targetStatus: string, message: string }
  const [editingIssue, setEditingIssue] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', start_date: '', end_date: '', max_events: 10, notes: '' })
  const [editingEvent, setEditingEvent] = useState(null)
  const [venues, setVenues] = useState([])
  const [selectedImage, setSelectedImage] = useState(null) // For art lightbox

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 10,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 150,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  useEffect(() => {
    loadData()
    loadVenues()
  }, [])

  // Auto-select issue from URL param (e.g., /crew/issues?issue=5)
  useEffect(() => {
    const issueId = searchParams.get('issue')
    if (issueId && issues.length > 0 && !selectedIssue) {
      const issue = issues.find(i => i.id === parseInt(issueId, 10))
      if (issue) {
        setSelectedIssue(issue)
      }
    }
  }, [issues, searchParams, selectedIssue])

  const loadVenues = async () => {
    try {
      const data = await api('/public/venues')
      setVenues(data)
    } catch (err) {
      console.error('Failed to load venues:', err)
    }
  }

  useEffect(() => {
    if (selectedIssue) {
      loadIssueEvents(selectedIssue.id)
    }
  }, [selectedIssue?.id])

  const loadData = async () => {
    try {
      const [issuesData, eventsData, artData] = await Promise.all([
        api('/issues'),
        api('/events?status=approved'),
        api('/issues/art/submissions?status=approved')
      ])
      setIssues(issuesData)
      setAllEvents(eventsData)
      setArtSubmissions(artData)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const loadIssueEvents = async (issueId) => {
    try {
      const data = await api(`/issues/${issueId}`)
      setIssueEvents(data.events || [])
      setPrintRuns(data.print_runs || [])
      setInventory(data.inventory || null)
      // Update selectedIssue with full data including new fields
      setSelectedIssue(prev => ({
        ...prev,
        content_locked_at: data.content_locked_at,
        print_deadline: data.print_deadline,
        sent_to_printer_at: data.sent_to_printer_at,
        received_from_printer_at: data.received_from_printer_at,
        front_art: data.front_art
      }))
    } catch (err) {
      console.error(err)
    }
  }

  const handleEventEdit = async (updates) => {
    try {
      await api(`/events/${editingEvent.id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      })
      setEditingEvent(null)
      loadIssueEvents(selectedIssue.id)
    } catch (err) {
      console.error('Failed to edit event:', err)
      throw err
    }
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    setMessage(null)
    try {
      const newIssue = await api('/issues', {
        method: 'POST',
        body: JSON.stringify(form)
      })
      setMessage({ type: 'success', text: 'Issue created!' })
      setShowCreate(false)
      // Reset form with fresh defaults
      const defaults = getDefaultsForType('monthly')
      setForm({
        issue_type: 'monthly',
        name: defaults.name,
        start_date: defaults.startDate,
        end_date: defaults.endDate,
        notes: '',
        max_events: 10
      })
      await loadData()
      // Auto-select the new issue
      setSelectedIssue(newIssue)
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
  }

  const handleUpdateStatus = async (issueId, newStatus, additionalData = {}) => {
    try {
      await api(`/issues/${issueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus, ...additionalData })
      })
      await loadData()
      if (selectedIssue?.id === issueId) {
        setSelectedIssue(prev => ({ ...prev, status: newStatus }))
        loadIssueEvents(issueId) // Reload to get updated timestamps
      }
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleFinalize = async () => {
    if (!selectedIssue) return
    try {
      await handleUpdateStatus(selectedIssue.id, 'finalized', {
        print_deadline: finalizeForm.print_deadline || null
      })
      setShowFinalizeModal(false)
      setFinalizeForm({ print_deadline: '' })
      setMessage({ type: 'success', text: 'Issue finalized! Events are now locked.' })
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleStartEdit = () => {
    if (!selectedIssue) return
    setEditForm({
      name: selectedIssue.name,
      start_date: selectedIssue.start_date,
      end_date: selectedIssue.end_date,
      max_events: selectedIssue.max_events || 10,
      notes: selectedIssue.notes || ''
    })
    setEditingIssue(true)
  }

  const handleSaveEdit = async () => {
    if (!selectedIssue) return

    // Validate max_events isn't below current count
    if (editForm.max_events < issueEvents.length) {
      setErrorModal(`Cannot set max events to ${editForm.max_events}. This issue already has ${issueEvents.length} events assigned.`)
      return
    }

    try {
      await api(`/issues/${selectedIssue.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editForm.name,
          start_date: editForm.start_date,
          end_date: editForm.end_date,
          max_events: editForm.max_events,
          notes: editForm.notes
        })
      })

      // Find events now outside the date range
      const eventsOutsideRange = issueEvents.filter(e =>
        e.event_date < editForm.start_date || e.event_date > editForm.end_date
      )

      // Unassign them
      for (const event of eventsOutsideRange) {
        await api(`/events/${event.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ issue_id: null })
        })
      }

      await loadData()
      setSelectedIssue(prev => ({
        ...prev,
        name: editForm.name,
        start_date: editForm.start_date,
        end_date: editForm.end_date,
        max_events: editForm.max_events,
        notes: editForm.notes
      }))
      await loadIssueEvents(selectedIssue.id)
      setEditingIssue(false)

      const removedCount = eventsOutsideRange.length
      setMessage({
        type: 'success',
        text: removedCount > 0
          ? `Issue updated. ${removedCount} event${removedCount > 1 ? 's' : ''} outside date range removed.`
          : 'Issue updated'
      })
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleCancelEdit = () => {
    setEditingIssue(false)
    setEditForm({ name: '', start_date: '', end_date: '', max_events: 10 })
  }

  const handleAssignArt = async (issueId, artId) => {
    try {
      await api(`/issues/${issueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ front_art_id: artId })
      })
      await loadData()
      if (selectedIssue?.id === issueId) {
        // Reload issue details to get front_art data for preview
        await loadIssueEvents(issueId)
      }
      setShowArtPicker(false)
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleDelete = async (issueId) => {
    try {
      await api(`/issues/${issueId}`, { method: 'DELETE' })
      if (selectedIssue?.id === issueId) {
        setSelectedIssue(null)
        setIssueEvents([])
      }
      loadData()
      setDeleteModal(null)
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleAssignEvent = async (eventId) => {
    if (!selectedIssue) return
    try {
      await api(`/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ issue_id: selectedIssue.id })
      })
      await Promise.all([loadData(), loadIssueEvents(selectedIssue.id)])
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleRemoveEvent = async (eventId) => {
    try {
      await api(`/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ issue_id: null })
      })
      await Promise.all([loadData(), loadIssueEvents(selectedIssue.id)])
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handlePreviewActivate = async (issue) => {
    try {
      const preview = await api(`/issues/${issue.id}/activate?preview=true`, { method: 'POST' })
      setActivatePreview(preview)
      setActivateModal(issue)
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleConfirmActivate = async () => {
    if (!activateModal) return
    try {
      await api(`/issues/${activateModal.id}/activate`, { method: 'POST' })
      setActivateModal(null)
      setActivatePreview(null)
      await loadData()
      if (selectedIssue?.id === activateModal.id) {
        setSelectedIssue(prev => ({ ...prev, is_active_for_requests: 1 }))
      }
      setMessage({ type: 'success', text: 'Issue activated for card requests!' })
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handlePreviewDeactivate = async (issue) => {
    try {
      const preview = await api(`/issues/${issue.id}/deactivate?preview=true`, { method: 'POST' })
      setActivatePreview({ ...preview, isDeactivate: true })
      setActivateModal(issue)
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleConfirmDeactivate = async () => {
    if (!activateModal) return
    try {
      await api(`/issues/${activateModal.id}/deactivate`, { method: 'POST' })
      setActivateModal(null)
      setActivatePreview(null)
      await loadData()
      if (selectedIssue?.id === activateModal.id) {
        setSelectedIssue(prev => ({ ...prev, is_active_for_requests: 0 }))
      }
      setMessage({ type: 'success', text: 'Card requests closed for this issue.' })
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleCloseIssue = async () => {
    if (!closeModal) return
    try {
      const result = await api(`/issues/${closeModal.id}/close`, {
        method: 'POST',
        body: JSON.stringify({
          force: true,
          write_off_reason: closeForm.write_off_reason || null
        })
      })
      setCloseModal(null)
      setCloseForm({ write_off_reason: '' })
      await loadData()
      if (selectedIssue?.id === closeModal.id) {
        setSelectedIssue(prev => ({ ...prev, status: 'distributed' }))
        loadIssueEvents(closeModal.id)
      }
      const writeOffMsg = result.written_off > 0 ? ` (${result.written_off} cards written off)` : ''
      setMessage({ type: 'success', text: `Issue closed and marked as distributed!${writeOffMsg}` })
    } catch (err) {
      setErrorModal(err.message)
    }
  }

  const handleDragEnd = async (event) => {
    const { active, over } = event

    if (active.id !== over?.id) {
      const oldIndex = issueEvents.findIndex(e => e.id === active.id)
      const newIndex = issueEvents.findIndex(e => e.id === over.id)

      const newOrder = arrayMove(issueEvents, oldIndex, newIndex)
      setIssueEvents(newOrder)

      // Update sort_order on backend
      const updates = newOrder.map((e, idx) => ({ id: e.id, sort_order: idx }))
      try {
        await api('/events/bulk/order', {
          method: 'PATCH',
          body: JSON.stringify({ events: updates })
        })
      } catch (err) {
        console.error('Failed to save order:', err)
        // Reload to restore correct order
        loadIssueEvents(selectedIssue.id)
      }
    }
  }

  // Move event up/down in list (mobile-friendly alternative to drag)
  const handleMoveEvent = async (eventId, direction) => {
    const currentIndex = issueEvents.findIndex(e => e.id === eventId)
    if (currentIndex === -1) return

    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
    if (newIndex < 0 || newIndex >= issueEvents.length) return

    const newOrder = arrayMove(issueEvents, currentIndex, newIndex)
    setIssueEvents(newOrder)

    // Update sort_order on backend
    const updates = newOrder.map((e, idx) => ({ id: e.id, sort_order: idx }))
    try {
      await api('/events/bulk/order', {
        method: 'PATCH',
        body: JSON.stringify({ events: updates })
      })
    } catch (err) {
      console.error('Failed to save order:', err)
      loadIssueEvents(selectedIssue.id)
    }
  }

  const getUnassignedEvents = () => {
    if (!selectedIssue) return []
    return allEvents.filter(e =>
      !e.issue_id &&
      e.event_date >= selectedIssue.start_date &&
      e.event_date <= selectedIssue.end_date
    )
  }

  const statusColors = {
    planning: 'var(--accent, var(--rust))',
    finalized: 'var(--blue-muted)',
    printed: 'var(--success)',
    distributed: '#666'
  }

  return (
    <div className="issues-page">
      <CrewNav counts={counts} />
      <div className="page-header">
        <h2>Issues</h2>
        <button className="btn hide-mobile" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : '+ New Issue'}
        </button>
      </div>

      {/* Mobile-only button below header */}
      <button className="btn show-mobile-only mb-md" style={{ width: '100%' }} onClick={() => setShowCreate(!showCreate)}>
        {showCreate ? 'Cancel' : '+ New Issue'}
      </button>

      {message && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}

      {/* Create Issue Modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <h3 className="card-title">Create New Issue</h3>
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label className="form-label">Issue Type</label>
                <div className="issue-type-buttons">
                  {ISSUE_TYPES.map(type => (
                    <button
                      key={type.value}
                      type="button"
                      className={`issue-type-btn ${form.issue_type === type.value ? 'active' : ''}`}
                      onClick={() => {
                        const defaults = getDefaultsForType(type.value)
                        setForm({
                          ...form,
                          issue_type: type.value,
                          name: defaults.name,
                          start_date: defaults.startDate,
                          end_date: defaults.endDate
                        })
                      }}
                    >
                      {type.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Issue Name</label>
                <input
                  type="text"
                  className="form-input"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder={form.issue_type === 'special' ? 'e.g., Musikfest Special' : 'Auto-generated based on type'}
                  required
                />
              </div>
              <div className="form-row-2">
                <div className="form-group">
                  <label className="form-label">Start Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={form.start_date}
                    onChange={e => setForm({ ...form, start_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">End Date</label>
                  <input
                    type="date"
                    className="form-input"
                    value={form.end_date}
                    onChange={e => setForm({ ...form, end_date: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <AutoGrowTextarea
                  value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  placeholder="Theme, deadline reminders, etc."
                />
              </div>
              <div className="form-group">
                <label className="form-label">Max Events</label>
                <input
                  type="number"
                  className="form-input"
                  value={form.max_events}
                  onChange={e => setForm({ ...form, max_events: parseInt(e.target.value) || 10 })}
                  min="1"
                  max="50"
                  style={{ maxWidth: '100px' }}
                />
                <small className="text-muted" style={{ display: 'block', marginTop: 'var(--space-xs)' }}>
                  Maximum events for this issue
                </small>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
                <button type="submit" className="btn btn-primary">Create Issue</button>
                <button type="button" className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="issues-layout">
        {/* Issues List - Left Side */}
        <div className="issues-list">
          <div className="card">
            <h3 className="card-title">All Issues</h3>
            {loading ? (
              <p className="text-muted">loading issues...</p>
            ) : issues.length === 0 ? (
              <EmptyState
                message="No issues yet"
                subtext="Create your first issue to get started!"
                action={{ label: 'Create Issue', onClick: () => setShowCreate(true) }}
              />
            ) : (
              issues.map(issue => (
                <div
                  key={issue.id}
                  className={`issue-card ${selectedIssue?.id === issue.id ? 'selected' : ''}`}
                  onClick={() => setSelectedIssue(issue)}
                >
                  <div className="issue-card-header">
                    <span className="issue-name">{issue.name}</span>
                    <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                      {issue.issue_type && issue.issue_type !== 'monthly' && (
                        <span
                          className="badge"
                          style={{ background: 'var(--purple)', color: 'white', fontSize: '0.65rem' }}
                        >
                          {issue.issue_type}
                        </span>
                      )}
                      {issue.is_active_for_requests === 1 && (
                        <span
                          className="badge"
                          style={{ background: 'var(--success)', color: 'white', fontSize: '0.65rem' }}
                        >
                          ACTIVE
                        </span>
                      )}
                      <span
                        className="badge"
                        style={{ background: statusColors[issue.status], color: 'white' }}
                      >
                        {issue.status}
                      </span>
                    </div>
                  </div>
                  {issue.notes && (
                    <div className="issue-notes">{issue.notes}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Issue Builder - Right Side */}
        <div className="issue-builder">
          {selectedIssue ? (
            <>
              {/* Issue Header */}
              <div className="card builder-header">
                <div className="builder-title-row">
                  <div className="builder-title-info">
                    <h3>{selectedIssue.name}</h3>
                    <span className="issue-dates">
                      {parseLocalDate(selectedIssue.start_date)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {' - '}
                      {parseLocalDate(selectedIssue.end_date)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                  </div>
                  <div className="builder-actions">
                    <ActionMenu compact actions={[
                      { label: 'Export', onClick: () => navigate(`/crew/issues/${selectedIssue.id}/export`) },
                      { label: 'Edit Issue', onClick: handleStartEdit },
                      ...(selectedIssue.status === 'finalized' ? [
                        { label: 'Revert to Planning', onClick: () => setRevertModal({
                          targetStatus: 'planning',
                          message: 'This will unlock the issue for content changes. Events can be added or removed again.'
                        }), danger: true }
                      ] : []),
                      ...(selectedIssue.status === 'printed' ? [
                        { label: 'Revert to Finalized', onClick: () => setRevertModal({
                          targetStatus: 'finalized',
                          message: 'This will reset the printed status. The "received from printer" timestamp will be cleared.'
                        }), danger: true }
                      ] : []),
                      ...(selectedIssue.status === 'distributed' ? [
                        { label: 'Revert to Printed', onClick: () => setRevertModal({
                          targetStatus: 'printed',
                          message: 'This will reopen the issue for deliveries. The issue will no longer be marked as complete.'
                        }), danger: true }
                      ] : []),
                      ...(selectedIssue.status === 'planning' ? [
                        { label: 'Delete Issue', onClick: () => setDeleteModal({ id: selectedIssue.id, name: selectedIssue.name }), danger: true }
                      ] : [])
                    ]} />
                  </div>
                </div>

                {/* Edit Issue Modal */}
                {editingIssue && createPortal(
                  <div className="modal-overlay" onClick={handleCancelEdit}>
                    <div className="modal card" onClick={e => e.stopPropagation()}>
                      <h3 className="card-title">Edit Issue</h3>
                      <div className="form-group">
                        <label className="form-label">Issue Name</label>
                        <input
                          type="text"
                          className="form-input"
                          value={editForm.name}
                          onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                          autoFocus
                        />
                      </div>
                      <div className="form-row-2">
                        <div className="form-group">
                          <label className="form-label">Start Date</label>
                          <input
                            type="date"
                            className="form-input"
                            value={editForm.start_date}
                            onChange={e => setEditForm({ ...editForm, start_date: e.target.value })}
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">End Date</label>
                          <input
                            type="date"
                            className="form-input"
                            value={editForm.end_date}
                            onChange={e => setEditForm({ ...editForm, end_date: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Max Events</label>
                        <input
                          type="number"
                          className="form-input"
                          value={editForm.max_events}
                          onChange={e => setEditForm({ ...editForm, max_events: parseInt(e.target.value) || issueEvents.length || 1 })}
                          min={issueEvents.length || 1}
                          max="50"
                        />
                        <small className="form-hint">
                          Currently {issueEvents.length} event{issueEvents.length !== 1 ? 's' : ''} assigned
                        </small>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Notes</label>
                        <AutoGrowTextarea
                          value={editForm.notes}
                          onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
                          placeholder="Optional notes (e.g., front art credit)"
                          className="form-textarea"
                        />
                      </div>
                      <div className="modal-actions">
                        <button className="btn btn-primary" onClick={handleSaveEdit}>
                          Save
                        </button>
                        <button className="btn" onClick={handleCancelEdit}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>,
                  document.body
                )}

                {/* Status Timeline */}
                <StatusTimeline currentStatus={selectedIssue.status} />

                {/* Status Actions */}
                <div className="status-actions" id="issue-status">
                  {selectedIssue.status === 'planning' && (
                    <button
                      className="btn btn-primary"
                      onClick={() => setShowFinalizeModal(true)}
                    >
                      Finalize Issue
                    </button>
                  )}
                  {selectedIssue.status === 'finalized' && (
                    <>
                      <button
                        className="btn btn-primary"
                        onClick={() => handleUpdateStatus(selectedIssue.id, 'printed')}
                        disabled={!inventory || inventory.total_printed === 0}
                        title={(!inventory || inventory.total_printed === 0) ? 'Add a print run with received cards first' : ''}
                      >
                        Mark as Printed
                      </button>
                      {(!inventory || inventory.total_printed === 0) && (
                        <span className="status-hint">Add a print run with received cards first</span>
                      )}
                    </>
                  )}
                  {selectedIssue.status === 'printed' && inventory && (
                    inventory.remaining <= 0 ? (
                      <div className="status-complete">
                        All cards delivered! Issue will auto-complete.
                      </div>
                    ) : (
                      <>
                        <div className="delivery-progress-status">
                          {inventory.total_delivered} of {inventory.total_printed} delivered ({inventory.remaining} remaining)
                        </div>
                        <div className="issue-action-buttons">
                          <button
                            className="btn"
                            onClick={() => selectedIssue.is_active_for_requests
                              ? handlePreviewDeactivate(selectedIssue)
                              : handlePreviewActivate(selectedIssue)
                            }
                          >
                            {selectedIssue.is_active_for_requests ? 'Close Requests' : 'Activate for Requests'}
                          </button>
                          <button
                            className="btn"
                            onClick={() => setCloseModal({ ...selectedIssue, inventory })}
                          >
                            Close Issue Early
                          </button>
                        </div>
                      </>
                    )
                  )}
                </div>

                {/* Finalization details */}
                {selectedIssue.content_locked_at && (
                  <div className="finalization-details">
                    <span className="detail-item">
                      Content locked: {new Date(selectedIssue.content_locked_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                    {selectedIssue.print_deadline && (
                      <span className="detail-item">
                        Print deadline: {parseLocalDate(selectedIssue.print_deadline)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    )}
                  </div>
                )}

                {/* Inventory Stats */}
                {selectedIssue.status !== 'planning' && (
                  <InventoryStats inventory={inventory} />
                )}

                {/* Art Selection */}
                <div className="art-section">
                  <div className="art-header">
                    <span className="art-label">Cover Art:</span>
                    {selectedIssue.front_art_id ? (
                      (() => {
                        // Use front_art from API response (works even when art is 'used' status)
                        const art = selectedIssue.front_art || artSubmissions.find(a => a.id === selectedIssue.front_art_id)
                        if (art && art.files?.[0]) {
                          const file = art.files[0]
                          const psdPreview = getPsdPreview(file)
                          const previewSrc = psdPreview ? getUploadUrl(psdPreview) : getUploadUrl(file)
                          return (
                            <div className="art-preview-container">
                              <img
                                src={previewSrc}
                                alt={art.artist_name}
                                className="art-preview-thumb"
                                onClick={() => setSelectedImage({ preview: previewSrc, original: getUploadUrl(file) })}
                                title="Click to view fullscreen"
                              />
                              <div className="art-preview-info">
                                <span className="art-selected">{art.artist_name}</span>
                                {art.credit_preference && art.credit_preference !== art.artist_name && (
                                  <span className="art-credit">Credit: {art.credit_preference}</span>
                                )}
                              </div>
                            </div>
                          )
                        }
                        return <span className="art-selected">{art?.artist_name || 'Unknown'}</span>
                      })()
                    ) : (
                      <span className="art-none">None selected</span>
                    )}
                    {selectedIssue.status === 'planning' && (
                      <button
                        className="btn btn-small"
                        onClick={() => setShowArtPicker(true)}
                      >
                        {selectedIssue.front_art_id ? 'Change Art' : 'Select Art'}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Events List with Drag & Drop */}
              <div className="card" id="issue-events">
                <div className="events-header">
                  <h4>
                    Events ({issueEvents.length}{selectedIssue.max_events ? ` / ${selectedIssue.max_events}` : ''})
                    {selectedIssue.max_events && issueEvents.length >= selectedIssue.max_events && (
                      <span className="badge badge-info" style={{ marginLeft: 'var(--space-sm)', fontSize: '0.7rem' }}>Full</span>
                    )}
                  </h4>
                </div>

                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={issueEvents.map(e => e.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="events-list">
                      {issueEvents.length === 0 ? (
                        <div className="empty-state">
                          No events assigned yet. Add events from the panel below.
                        </div>
                      ) : (
                        issueEvents.map((event, index) => (
                          <SortableEventItem
                            key={event.id}
                            event={event}
                            onRemove={handleRemoveEvent}
                            onEdit={setEditingEvent}
                            onMove={handleMoveEvent}
                            isEditable={selectedIssue.status === 'planning'}
                            isFirst={index === 0}
                            isLast={index === issueEvents.length - 1}
                          />
                        ))
                      )}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>

              {/* Quick Assign Panel */}
              {selectedIssue.status === 'planning' && (
                <div className="card" id="quick-assign">
                  <QuickAssignPanel
                    unassignedEvents={getUnassignedEvents()}
                    onAssign={handleAssignEvent}
                    isFull={selectedIssue.max_events && issueEvents.length >= selectedIssue.max_events}
                  />
                </div>
              )}

              {/* Print Runs Section */}
              <div className="card" id="print-runs">
                <PrintRunsSection
                  issueId={selectedIssue.id}
                  issueName={selectedIssue.name}
                  issueStatus={selectedIssue.status}
                  printRuns={printRuns}
                  onUpdate={() => loadIssueEvents(selectedIssue.id)}
                  api={api}
                  isEditable={selectedIssue.status !== 'distributed'}
                  autoOpenReceiveId={searchParams.get('showReceive') ? parseInt(searchParams.get('showReceive'), 10) : null}
                />
              </div>
            </>
          ) : (
            <div className="card empty-builder">
              <div className="empty-builder-content">
                <h3>Select an Issue</h3>
                <p>Click on an issue from the list to start building it, or create a new one.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {deleteModal && (
        <ConfirmModal
          title="Delete Issue"
          message={`Delete the ${deleteModal.name} issue? Events will be unassigned but not deleted.`}
          confirmText="Delete"
          onConfirm={() => handleDelete(deleteModal.id)}
          onCancel={() => setDeleteModal(null)}
        />
      )}

      {/* Error Modal */}
      {errorModal && (
        <MessageModal
          title="Error"
          message={errorModal}
          type="error"
          onClose={() => setErrorModal(null)}
        />
      )}

      {/* Activation Confirmation Modal */}
      {activateModal && activatePreview && (
        <div className="modal-overlay" onClick={() => { setActivateModal(null); setActivatePreview(null); }}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <h3 className="card-title">
              {activatePreview.isDeactivate ? 'Close Card Requests?' : 'Activate Issue for Card Requests?'}
            </h3>

            <p style={{ marginBottom: 'var(--space-md)' }}>
              <strong>{activateModal.name}</strong>
            </p>

            {!activatePreview.isDeactivate && activatePreview.currentActive && (
              <div style={{
                padding: 'var(--space-md)',
                background: 'rgba(201, 162, 39, 0.1)',
                borderRadius: '4px',
                marginBottom: 'var(--space-md)'
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: 'var(--space-xs)' }}>
                  This will close: {activatePreview.currentActive.name}
                </div>
                {activatePreview.pendingRequestsToExpire > 0 && (
                  <div style={{ color: 'var(--warning)' }}>
                    {activatePreview.pendingRequestsToExpire} unfulfilled request(s) will be marked expired
                  </div>
                )}
              </div>
            )}

            {activatePreview.isDeactivate && activatePreview.pendingRequestsToExpire > 0 && (
              <div style={{
                padding: 'var(--space-md)',
                background: 'rgba(201, 162, 39, 0.1)',
                borderRadius: '4px',
                marginBottom: 'var(--space-md)'
              }}>
                <div style={{ color: 'var(--warning)' }}>
                  {activatePreview.pendingRequestsToExpire} unfulfilled request(s) will be marked expired
                </div>
              </div>
            )}

            <p style={{ opacity: 0.8, marginBottom: 'var(--space-lg)' }}>
              {activatePreview.isDeactivate
                ? 'Distro points will not be able to request postcards until another issue is activated.'
                : 'Distro points will be able to request postcards for this issue.'}
            </p>

            <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
              <button
                className="btn btn-primary"
                style={{
                  flex: 1,
                  background: activatePreview.isDeactivate ? 'var(--gray)' : 'var(--success)',
                  borderColor: activatePreview.isDeactivate ? 'var(--gray)' : 'var(--success)'
                }}
                onClick={activatePreview.isDeactivate ? handleConfirmDeactivate : handleConfirmActivate}
              >
                {activatePreview.isDeactivate ? 'Close Requests' : 'Activate'}
              </button>
              <button
                className="btn"
                style={{ flex: 1 }}
                onClick={() => { setActivateModal(null); setActivatePreview(null); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Finalization Modal */}
      {showFinalizeModal && selectedIssue && (
        <div className="modal-overlay" onClick={() => setShowFinalizeModal(false)}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <h3 className="card-title">Finalize Issue</h3>

            <p style={{ marginBottom: 'var(--space-md)' }}>
              <strong>{selectedIssue.name}</strong>
            </p>

            <div style={{
              padding: 'var(--space-md)',
              background: 'rgba(201, 162, 39, 0.1)',
              borderRadius: '4px',
              marginBottom: 'var(--space-md)'
            }}>
              <div style={{ fontWeight: 'bold', marginBottom: 'var(--space-xs)' }}>
                This will lock the event list
              </div>
              <div style={{ opacity: 0.8 }}>
                Events cannot be added or removed after finalization. You can still edit event details (typos, etc).
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: 'var(--space-lg)' }}>
              <label className="form-label">Print Deadline (optional)</label>
              <input
                type="date"
                className="form-input"
                value={finalizeForm.print_deadline}
                onChange={e => setFinalizeForm({ ...finalizeForm, print_deadline: e.target.value })}
              />
              <small style={{ opacity: 0.7 }}>When content needs to go to the printer</small>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={handleFinalize}
              >
                Finalize Issue
              </button>
              <button
                className="btn"
                style={{ flex: 1 }}
                onClick={() => { setShowFinalizeModal(false); setFinalizeForm({ print_deadline: '' }); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close Issue Early Modal */}
      {closeModal && (
        <div className="modal-overlay" onClick={() => { setCloseModal(null); setCloseForm({ write_off_reason: '' }); }}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <h3 className="card-title">Close Issue Early?</h3>

            <p style={{ marginBottom: 'var(--space-md)' }}>
              <strong>{closeModal.name}</strong>
            </p>

            <div style={{
              padding: 'var(--space-md)',
              background: 'rgba(201, 162, 39, 0.1)',
              borderRadius: '4px',
              marginBottom: 'var(--space-md)'
            }}>
              <div style={{ marginBottom: 'var(--space-sm)' }}>
                <strong>Current inventory:</strong>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-lg)', marginBottom: 'var(--space-sm)' }}>
                <span>{closeModal.inventory?.total_printed || 0} printed</span>
                <span>{closeModal.inventory?.total_delivered || 0} delivered</span>
                <span style={{ color: 'var(--warning)' }}>{closeModal.inventory?.remaining || 0} remaining</span>
              </div>
              {closeModal.inventory?.remaining > 0 && (
                <div style={{ color: 'var(--warning)', fontStyle: 'italic' }}>
                  {closeModal.inventory.remaining} card(s) will be written off as undelivered
                </div>
              )}
            </div>

            {closeModal.inventory?.remaining > 0 && (
              <div className="form-group" style={{ marginBottom: 'var(--space-lg)' }}>
                <label className="form-label">Write-off reason (optional)</label>
                <input
                  type="text"
                  className="form-input"
                  value={closeForm.write_off_reason}
                  onChange={e => setCloseForm({ write_off_reason: e.target.value })}
                  placeholder="e.g., Lost in transit, damaged, etc."
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1, background: 'var(--warning)', borderColor: 'var(--warning)' }}
                onClick={handleCloseIssue}
              >
                Close Issue
              </button>
              <button
                className="btn"
                style={{ flex: 1 }}
                onClick={() => { setCloseModal(null); setCloseForm({ write_off_reason: '' }); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revert Status Modal */}
      {revertModal && selectedIssue && (
        <ConfirmModal
          title={`Revert to ${revertModal.targetStatus.charAt(0).toUpperCase() + revertModal.targetStatus.slice(1)}?`}
          message={revertModal.message}
          confirmText="Revert"
          confirmStyle="danger"
          onConfirm={async () => {
            await handleUpdateStatus(selectedIssue.id, revertModal.targetStatus)
            setRevertModal(null)
            setMessage({ type: 'success', text: `Issue reverted to ${revertModal.targetStatus}` })
          }}
          onCancel={() => setRevertModal(null)}
        />
      )}

      {/* Event Edit Modal */}
      {editingEvent && (
        <EventEditModal
          event={editingEvent}
          venues={venues}
          onSave={handleEventEdit}
          onClose={() => setEditingEvent(null)}
        />
      )}

      {/* Art Selection Modal */}
      {showArtPicker && selectedIssue && (
        <div className="modal-overlay" onClick={() => setShowArtPicker(false)}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <h3 className="card-title">Select Cover Art</h3>
            {artSubmissions.length === 0 ? (
              <p className="empty-state">No approved art submissions</p>
            ) : (
              <div className="art-grid">
                {artSubmissions.map(art => (
                  <button
                    key={art.id}
                    className={`art-option ${selectedIssue.front_art_id === art.id ? 'selected' : ''}`}
                    onClick={() => {
                      handleAssignArt(selectedIssue.id, art.id)
                      setShowArtPicker(false)
                    }}
                  >
                    {art.files?.[0] && (
                      <img src={getUploadUrl(art.files[0])} alt={art.artist_name} />
                    )}
                    <span>{art.artist_name}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="modal-actions-end">
              <button className="btn" onClick={() => setShowArtPicker(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Art Lightbox for viewing full image */}
      {selectedImage && (
        <div className="modal-overlay" onClick={() => setSelectedImage(null)}>
          <div className="art-lightbox" onClick={e => e.stopPropagation()}>
            <img src={selectedImage.preview} alt="Full size artwork" />
            <div className="art-lightbox-actions">
              <a
                href={selectedImage.original}
                download
                onClick={e => e.stopPropagation()}
              >
                Download{selectedImage.original !== selectedImage.preview ? ' (Original)' : ''}
              </a>
              <button
                className="art-lightbox-close"
                onClick={() => setSelectedImage(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
