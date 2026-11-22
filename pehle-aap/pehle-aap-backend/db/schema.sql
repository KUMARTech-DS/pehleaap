CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS wedding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  event_start DATE,
  event_end DATE,
  venue_name TEXT,
  city TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS person (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('couple','team','vendor','guest')),
  phone TEXT,
  preferred_lang TEXT NOT NULL DEFAULT 'en-IN',
  elders BOOLEAN NOT NULL DEFAULT false,
  access_key_hash TEXT UNIQUE NOT NULL,
  vendor_id UUID,
  family_id UUID,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wedding_function (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  starts_at TIMESTAMPTZ,
  venue TEXT,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vendor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  source TEXT NOT NULL DEFAULT 'own_vendor',
  preferred_lang TEXT NOT NULL DEFAULT 'en-IN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendor(id),
  agreed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_included BOOLEAN,
  payment_mode TEXT,
  status TEXT NOT NULL DEFAULT 'booked',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_function (
  booking_id UUID REFERENCES booking(id) ON DELETE CASCADE,
  function_id UUID REFERENCES wedding_function(id) ON DELETE CASCADE,
  PRIMARY KEY (booking_id, function_id)
);

CREATE TABLE IF NOT EXISTS payment_milestone (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  due_at DATE,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ,
  mode TEXT,
  receipt_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS task (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('prep_item','duty','readiness_check','vendor_follow_up','guest_care')),
  title TEXT NOT NULL,
  qty INT,
  function_id UUID REFERENCES wedding_function(id),
  vendor_id UUID REFERENCES vendor(id),
  owner_id UUID REFERENCES person(id),
  backup_id UUID REFERENCES person(id),
  due_at TIMESTAMPTZ,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  repeat_rule TEXT,
  status TEXT NOT NULL DEFAULT 'to_do'
    CHECK (status IN ('to_do','arranged','confirmed','set_up','done','at_risk')),
  progress_note TEXT,
  proof_path TEXT,
  updated_by UUID REFERENCES person(id),
  updated_via TEXT CHECK (updated_via IN ('tap','voice')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('event','vendor')),
  scope_id UUID NOT NULL,
  can_see_amounts BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(member_id, scope, scope_id)
);

CREATE TABLE IF NOT EXISTS family (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  family_name TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('bride','groom')),
  relation TEXT,
  phone TEXT,
  preferred_lang TEXT NOT NULL DEFAULT 'en-IN',
  invite_key_hash TEXT UNIQUE NOT NULL,
  headcount INT NOT NULL DEFAULT 1,
  elders BOOLEAN NOT NULL DEFAULT false,
  rsvp_status TEXT NOT NULL DEFAULT 'pending',
  leave_by TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guest_checkin (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES family(id),
  token_no BIGINT NOT NULL,
  headcount INT NOT NULL,
  arrived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  UNIQUE(family_id),
  UNIQUE(token_no)
);

CREATE TABLE IF NOT EXISTS stage_log (
  id BIGSERIAL PRIMARY KEY,
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  family_id UUID REFERENCES family(id),
  token_no BIGINT,
  action TEXT NOT NULL CHECK (action IN ('called','skipped','paused','resumed','walk_in')),
  actor_id UUID REFERENCES person(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gift_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  family_id UUID REFERENCES family(id),
  token_no BIGINT,
  gift_type TEXT NOT NULL CHECK (gift_type IN ('wishlist','cash','gift_box','upi','unknown')),
  description TEXT,
  amount NUMERIC(12,2),
  estimated_value NUMERIC(12,2),
  thanked_at TIMESTAMPTZ,
  recorded_by UUID REFERENCES person(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expense (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  event_id UUID REFERENCES wedding_function(id),
  task_id UUID REFERENCES task(id),
  payer_id UUID REFERENCES person(id),
  item TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  mode TEXT,
  category TEXT NOT NULL DEFAULT 'Miscellaneous',
  confidence NUMERIC(5,4),
  reimbursed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voice_update (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  speaker_id UUID REFERENCES person(id),
  speaker_type TEXT,
  event_id UUID REFERENCES wedding_function(id),
  audio_path TEXT,
  original_text TEXT NOT NULL,
  original_lang TEXT,
  translations JSONB NOT NULL DEFAULT '{}'::jsonb,
  extracted_change JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by UUID REFERENCES person(id),
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wishlist_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  claimed_by_family UUID REFERENCES family(id),
  claimed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS thank_you_open (
  id BIGSERIAL PRIMARY KEY,
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  family_id UUID REFERENCES family(id),
  variant TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody_log (
  id BIGSERIAL PRIMARY KEY,
  wedding_id UUID NOT NULL REFERENCES wedding(id) ON DELETE CASCADE,
  holder_id UUID REFERENCES person(id),
  action TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_wedding_due ON task(wedding_id, due_at);
CREATE INDEX IF NOT EXISTS idx_booking_vendor ON booking(vendor_id);
CREATE INDEX IF NOT EXISTS idx_family_wedding ON family(wedding_id);
CREATE INDEX IF NOT EXISTS idx_gift_wedding ON gift_entry(wedding_id);
CREATE INDEX IF NOT EXISTS idx_stage_log_wedding ON stage_log(wedding_id, created_at);
