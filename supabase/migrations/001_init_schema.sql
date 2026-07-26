-- ============================================================
-- 001_init_schema.sql — 임대관리 앱 초기 스키마
-- ============================================================

-- 가족 화이트리스트
create table allowed_emails (
  email text primary key,
  name text not null
);

-- 로그인한 사용자 프로필
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text,
  created_at timestamptz default now()
);

-- 신규 가입 시 자동으로 profiles 생성
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- RLS 허용 여부 확인 함수
create or replace function is_allowed_user() returns boolean as $$
  select exists (
    select 1 from allowed_emails where email = auth.jwt() ->> 'email'
  );
$$ language sql security definer stable;

-- 호실
create table units (
  id uuid primary key default gen_random_uuid(),
  unit_no text unique not null,
  memo text,
  created_at timestamptz default now()
);

-- 세입자
create table tenants (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid references units(id) on delete cascade,
  name text not null,
  phone text,
  residents int not null default 1 check (residents > 0),
  move_in_date date,
  move_out_date date,
  contract_end date,
  auto_renew boolean default false,
  deposit numeric(12,0),
  payment_day int check (payment_day between 1 and 31),
  memo text,
  created_at timestamptz default now()
);

create index idx_tenants_active on tenants(unit_id) where move_out_date is null;

-- 월세 변경 이력
create table rent_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  rent_amount numeric(12,0) not null,
  effective_from date not null,
  created_at timestamptz default now()
);

-- 세입자 문서
create table tenant_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  file_path text not null,
  file_name text not null,
  doc_type text,
  uploaded_by uuid references profiles(id),
  uploaded_at timestamptz default now()
);

-- 비용 항목 마스터
create table expense_types (
  code text primary key,
  label text not null,
  split_method text not null default 'BY_RESIDENTS',
  created_at timestamptz default now()
);

insert into expense_types (code, label, split_method) values
  ('RENT', '월세', 'FIXED'),
  ('WATER', '수도세', 'BY_RESIDENTS'),
  ('SEPTIC', '정화조 청소비', 'BY_RESIDENTS');

-- 공동비용 고지서
create table utility_bills (
  id uuid primary key default gen_random_uuid(),
  expense_type_code text references expense_types(code),
  period_start date,
  period_end date,
  total_amount numeric(12,0) not null,
  usage_amount numeric(10,2),
  usage_unit text default '㎥',
  billed_month date not null,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references profiles(id),
  corrects_bill_id uuid references utility_bills(id)
);

create unique index idx_utility_bills_unique
on utility_bills (expense_type_code, billed_month, period_start, period_end)
where cancelled_at is null;

-- 월별 청구 묶음
create table monthly_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  billing_month date not null,
  note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (tenant_id, billing_month)
);

-- 청구 항목 상세
create table charge_details (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid references monthly_charges(id) on delete cascade,
  expense_type_code text references expense_types(code),
  amount numeric(12,0) not null,
  source_bill_id uuid references utility_bills(id),
  source_rent_history_id uuid references rent_history(id),
  created_at timestamptz default now()
);

create unique index idx_charge_details_unique
on charge_details (charge_id, expense_type_code, coalesce(source_bill_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- 입금 이력
create table payment_history (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid references monthly_charges(id) on delete cascade,
  payment_date date not null,
  amount numeric(12,0) not null,
  memo text,
  created_by uuid references profiles(id),
  reversed_at timestamptz,
  reversed_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- 청구 상태 뷰
create view monthly_charges_status as
select
  mc.id,
  mc.tenant_id,
  mc.billing_month,
  mc.note,
  coalesce(cd.total_amount, 0) as total_amount,
  coalesce(ph.paid_amount, 0) as paid_amount,
  coalesce(cd.total_amount, 0) - coalesce(ph.paid_amount, 0) as outstanding,
  case
    when coalesce(ph.paid_amount, 0) <= 0 then '미납'
    when coalesce(ph.paid_amount, 0) >= coalesce(cd.total_amount, 0) then '완납'
    else '부분납'
  end as status
from monthly_charges mc
left join (
  select charge_id, sum(amount) as total_amount
  from charge_details
  group by charge_id
) cd on cd.charge_id = mc.id
left join (
  select charge_id, sum(amount) as paid_amount
  from payment_history
  where reversed_at is null
  group by charge_id
) ph on ph.charge_id = mc.id;

-- ============================================================
-- RLS 활성화 + 정책 (모든 테이블)
-- ============================================================

alter table allowed_emails enable row level security;
alter table profiles enable row level security;
alter table units enable row level security;
alter table tenants enable row level security;
alter table rent_history enable row level security;
alter table tenant_documents enable row level security;
alter table expense_types enable row level security;
alter table utility_bills enable row level security;
alter table monthly_charges enable row level security;
alter table charge_details enable row level security;
alter table payment_history enable row level security;

-- allowed_emails: 읽기만 허용 (쓰기는 관리자가 직접 DB에서)
create policy "allowed_read" on allowed_emails for select using (is_allowed_user());

-- profiles
create policy "profiles_read" on profiles for select using (is_allowed_user());
create policy "profiles_insert" on profiles for insert with check (is_allowed_user());
create policy "profiles_update" on profiles for update using (is_allowed_user());

-- units
create policy "units_all" on units for all using (is_allowed_user());

-- tenants
create policy "tenants_all" on tenants for all using (is_allowed_user());

-- rent_history
create policy "rent_history_all" on rent_history for all using (is_allowed_user());

-- tenant_documents
create policy "docs_all" on tenant_documents for all using (is_allowed_user());

-- expense_types
create policy "expense_types_all" on expense_types for all using (is_allowed_user());

-- utility_bills
create policy "bills_all" on utility_bills for all using (is_allowed_user());

-- monthly_charges
create policy "charges_all" on monthly_charges for all using (is_allowed_user());

-- charge_details
create policy "charge_details_all" on charge_details for all using (is_allowed_user());

-- payment_history
create policy "payments_all" on payment_history for all using (is_allowed_user());

-- ============================================================
-- Storage 버킷 (Supabase 대시보드에서 직접 생성 필요)
-- 아래 SQL은 참고용 — Storage 버킷 정책 설정
-- ============================================================
-- INSERT INTO storage.buckets (id, name, public) VALUES ('tenant-documents', 'tenant-documents', false);

-- Storage 정책 (버킷 생성 후 대시보드 Storage > Policies에서 설정)
-- SELECT: is_allowed_user()
-- INSERT: is_allowed_user()
-- UPDATE: is_allowed_user()
-- DELETE: is_allowed_user()
