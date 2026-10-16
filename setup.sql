-- =====================================================================
--  POS SATE — database Supabase (jalankan SEKALI di Supabase > SQL Editor)
--  Aman dijalankan ulang (memperbarui fungsi, data tidak dihapus).
--  Semua tabel ada di skema "pos" yang TIDAK terbuka untuk internet.
--  Satu-satunya pintu masuk: fungsi public.pos_api(p jsonb).
-- =====================================================================
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists pos;

create table if not exists pos.users(
  id bigint generated always as identity primary key,
  username text not null unique,
  name text not null,
  role text not null check (role in ('owner','staff')),
  perms jsonb not null default '[]',
  pw text not null,                       -- bcrypt (pgcrypto), bukan sandi asli
  active boolean not null default true,
  last_login timestamptz,
  created_at timestamptz not null default now());
create table if not exists pos.sessions(
  th text primary key,                    -- sha256 dari token; token asli tidak disimpan
  uid bigint not null references pos.users(id) on delete cascade,
  exp timestamptz not null);
create index if not exists sessions_uid on pos.sessions(uid);
create table if not exists pos.audit(
  id bigint generated always as identity primary key,
  t timestamptz not null default now(), uid bigint, uname text not null default '',
  action text not null, detail text not null default '');
create table if not exists pos.doc(
  id int primary key check (id = 1), json jsonb, version int not null default 0, updated_at timestamptz);
insert into pos.doc(id, json, version) values (1, null, 0) on conflict do nothing;
create table if not exists pos.snapshots(
  day date primary key, json jsonb not null, version int not null, created_at timestamptz not null default now());
create table if not exists pos.co(
  id bigint generated always as identity primary key,
  tok text not null unique, idem text unique, day date not null, num text not null,
  name text not null, tbl text not null default '', type text not null, note text not null default '',
  lines jsonb not null, sub numeric not null, tax numeric not null, total numeric not null,
  status text not null default 'new', printed int not null default 0, claim_at bigint,
  sale_no text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
alter table pos.co add column if not exists pay text not null default '';
alter table pos.co add column if not exists pst int not null default 0;
create index if not exists co_day on pos.co(day);
create index if not exists co_status on pos.co(status, id);
create table if not exists pos.meta(k text primary key, v jsonb not null);
insert into pos.meta(k, v) values ('rev', to_jsonb((extract(epoch from now()) * 1000)::bigint)) on conflict do nothing;
create table if not exists pos.fails(ip text primary key, n int not null default 0, until timestamptz);
create table if not exists pos.hits(id bigint generated always as identity primary key, ip text not null, t timestamptz not null default now());
create index if not exists hits_ip on pos.hits(ip, t);

alter table pos.users enable row level security;  alter table pos.sessions enable row level security;
alter table pos.audit enable row level security;  alter table pos.doc enable row level security;
alter table pos.snapshots enable row level security; alter table pos.co enable row level security;
alter table pos.meta enable row level security;   alter table pos.fails enable row level security;
alter table pos.hits enable row level security;

-- ---------------------------------------------------------------- pembantu
create or replace function pos.r(s int, b jsonb) returns jsonb language sql immutable as
$$ select jsonb_build_object('s', s, 'b', b) $$;

create or replace function pos.num(j jsonb) returns numeric language sql immutable as $$
  select case jsonb_typeof(j)
    when 'number' then (j #>> '{}')::numeric
    when 'string' then case when (j #>> '{}') ~ '^\s*-?\d{1,15}(\.\d{1,8})?\s*$' then btrim(j #>> '{}')::numeric else 0 end
    when 'boolean' then case when j = 'true'::jsonb then 1 else 0 end
    else 0 end $$;

create or replace function pos.clean(t text, n int) returns text language sql immutable as
$$ select left(btrim(regexp_replace(regexp_replace(coalesce(t, ''), '[[:cntrl:]]+', ' ', 'g'), '\s+', ' ', 'g')), n) $$;

create or replace function pos.iso(ts timestamptz) returns text language sql immutable as
$$ select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create or replace function pos.tz() returns text language sql stable as
$$ select coalesce((select v #>> '{}' from pos.meta where k = 'tz'), 'Asia/Jakarta') $$;

create or replace function pos.bump() returns void language sql as
$$ update pos.meta set v = to_jsonb(((v #>> '{}')::numeric + 1)::bigint) where k = 'rev' $$;

create or replace function pos.rev() returns bigint language sql stable as
$$ select (v #>> '{}')::bigint from pos.meta where k = 'rev' $$;

create or replace function pos.audit(uid bigint, uname text, act text, det text) returns void language plpgsql as $$
begin
  insert into pos.audit(uid, uname, action, detail) values (uid, coalesce(uname, ''), act, left(coalesce(det, ''), 300));
  if random() < 0.02 then delete from pos.audit where id < (select max(id) - 2000 from pos.audit); end if;
end $$;

create or replace function pos.client_ip() returns text language plpgsql stable as $$
declare h jsonb; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v := nullif(btrim(coalesce(h ->> 'cf-connecting-ip', '')), '');
  if v is null then v := nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1)), ''); end if;
  return coalesce(v, '?');
end $$;

create or replace function pos.clean_perms(j jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(x order by o), '[]'::jsonb) from (
    select x, min(o) o from jsonb_array_elements_text(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) with ordinality t(x, o)
    where x in ('co','inv','hist','prn','set') group by x) s $$;

create or replace function pos.perms_of(u pos.users) returns jsonb language sql immutable as
$$ select case when u.role = 'owner' then '["co","inv","hist","prn","set"]'::jsonb else pos.clean_perms(u.perms) end $$;

create or replace function pos.can(u pos.users, k text) returns boolean language sql immutable as
$$ select u.role = 'owner' or pos.perms_of(u) ? k $$;

create or replace function pos.me_view(u pos.users) returns jsonb language sql stable as $$
  select jsonb_build_object('id', u.id, 'username', u.username, 'name', u.name, 'role', u.role, 'perms', pos.perms_of(u),
    'active', u.active, 'lastLogin', coalesce(pos.iso(u.last_login), ''), 'createdAt', pos.iso(u.created_at)) $$;

create or replace function pos.auth(tok text) returns pos.users language plpgsql as $$
declare u pos.users;
begin
  if tok is null or length(tok) < 20 or length(tok) > 200 then return null; end if;
  select us.* into u from pos.sessions s join pos.users us on us.id = s.uid
   where s.th = encode(extensions.digest(tok, 'sha256'), 'hex') and s.exp > now() and us.active;
  return u;
end $$;

create or replace function pos.new_session(uid bigint) returns text language plpgsql as $$
declare t text := 'ps' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  insert into pos.sessions(th, uid, exp) values (encode(extensions.digest(t, 'sha256'), 'hex'), uid, now() + interval '90 days');
  if random() < 0.1 then delete from pos.sessions where exp < now(); end if;
  return t;
end $$;

-- ------------------------------------------------------------ pesanan: tampilan
create or replace function pos.staff_view(r pos.co) returns jsonb language sql stable as $$
  select jsonb_build_object('id', r.id, 'num', r.num, 'name', r.name, 'tbl', r.tbl, 'type', r.type, 'note', r.note, 'lines', r.lines,
    'sub', r.sub, 'tax', r.tax, 'total', r.total, 'status', r.status, 'printed', r.printed, 'saleNo', coalesce(r.sale_no, ''), 'pay', r.pay, 'pst', r.pst,
    't', pos.iso(r.created_at), 'u', pos.iso(r.updated_at)) $$;
create or replace function pos.cust_view(r pos.co) returns jsonb language sql stable as $$
  select jsonb_build_object('num', r.num, 'name', r.name, 'tbl', r.tbl, 'type', r.type, 'note', r.note, 'lines', r.lines,
    'total', r.total, 'sub', r.sub, 'tax', r.tax, 'status', r.status, 'pay', r.pay, 'pst', r.pst, 't', pos.iso(r.created_at)) $$;
create or replace function pos.co_set() returns jsonb language sql stable as $$
  select jsonb_build_object('on', coalesce((select v ->> 'on' from pos.meta where k = 'co'), 'true') <> 'false',
    'msg', left(coalesce((select v ->> 'msg' from pos.meta where k = 'co'), ''), 200)) $$;

-- ------------------------------------------------------------ penjaga tulis (karyawan)
create or replace function pos.additive(a jsonb, b jsonb) returns boolean language plpgsql immutable as $$
declare k text;
begin
  if jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
    for k in select jsonb_object_keys(a) loop
      if not (b ? k) or not coalesce(pos.additive(a -> k, b -> k), false) then return false; end if;
    end loop;
    return true;
  end if;
  return coalesce(a = b, false);
end $$;

create or replace function pos.valid_doc(d jsonb) returns boolean language sql immutable as $$
  select jsonb_typeof(d) = 'object' and jsonb_typeof(d -> 'items') = 'array' and jsonb_typeof(d -> 'orders') = 'array'
     and jsonb_typeof(d -> 'set') = 'object' $$;

create or replace function pos.guard(me pos.users, cur jsonb, nxt jsonb) returns text language plpgsql as $$
declare pm jsonb; k text; c jsonb; n jsonb; ci int; ni int; cs jsonb; ns jsonb;
begin
  if me.role = 'owner' then return null; end if;
  if cur is null then return 'Hanya owner yang boleh menyiapkan data awal'; end if;
  pm := pos.perms_of(me);
  if exists (select o ->> 'no', o from jsonb_array_elements(coalesce(cur -> 'orders', '[]')) o
             except select x ->> 'no', x from jsonb_array_elements(coalesce(nxt -> 'orders', '[]')) x) then
    return 'Riwayat penjualan hanya bisa ditambah, tidak boleh diubah atau dihapus (khusus owner)';
  end if;
  if not (pm ? 'inv') then
    select count(distinct i ->> 'id') into ci from jsonb_array_elements(cur -> 'items') i;
    select count(distinct i ->> 'id') into ni from jsonb_array_elements(nxt -> 'items') i;
    if ci <> ni then return 'Anda tidak punya izin menambah/menghapus menu'; end if;
    for c in select i from jsonb_array_elements(cur -> 'items') i loop
      n := null;
      select x into n from jsonb_array_elements(nxt -> 'items') x where x ->> 'id' = c ->> 'id' limit 1;
      if n is null then return 'Anda tidak punya izin menghapus menu'; end if;
      for k in select jsonb_object_keys(c) loop
        if k <> 'stock' and not coalesce(pos.additive(c -> k, n -> k), false) then
          return 'Anda tidak punya izin mengubah menu/harga: ' || coalesce(c ->> 'name', c ->> 'id');
        end if;
      end loop;
    end loop;
    select coalesce(jsonb_agg(x order by x), '[]') into cs from jsonb_array_elements(coalesce(cur -> 'cats', '[]')) x;
    select coalesce(jsonb_agg(x order by x), '[]') into ns from jsonb_array_elements(coalesce(nxt -> 'cats', '[]')) x;
    if cs <> ns then return 'Anda tidak punya izin mengubah kategori'; end if;
  end if;
  for k in select jsonb_object_keys(coalesce(cur -> 'set', '{}')) loop
    if (nxt -> 'set') ? k and coalesce(pos.additive(cur -> 'set' -> k, nxt -> 'set' -> k), false) then continue; end if;
    if k in ('gv','lang','fsAuto','logoInit','logoApp') or pm ? 'set' or (k = 'prn' and pm ? 'prn') then continue; end if;
    return 'Anda tidak punya izin mengubah pengaturan (' || k || ')';
  end loop;
  return null;
end $$;

-- ------------------------------------------------------------ menu & pesanan pelanggan
create or replace function pos.pay_cfg(s jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'on', coalesce((s #>> '{pay,on}') = 'true', false) and coalesce((s #>> '{pay,qr}') ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$', false),
    'qr', case when coalesce((s #>> '{pay,qr}') ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$', false) then s #>> '{pay,qr}' else '' end,
    'name', left(coalesce(s #>> '{pay,name}', ''), 60), 'note', left(coalesce(s #>> '{pay,note}', ''), 300)) $$;

create or replace function pos.pub_menu(q jsonb) returns jsonb language plpgsql stable as $$
declare d jsonb; v int; s jsonb; st jsonb := pos.co_set(); items jsonb; ucats text[]; ccats text[]; res text[] := '{}'; x text;
begin
  select json, version into d, v from pos.doc where id = 1;
  if d is null then return pos.r(503, '{"error":"belum siap"}'); end if;
  if q ->> 'since' = v::text then
    return pos.r(200, jsonb_build_object('ver', v, 'unchanged', true, 'open', st -> 'on', 'msg', st -> 'msg'));
  end if;
  s := coalesce(d -> 'set', '{}');
  select coalesce(jsonb_agg(jsonb_build_object('id', i ->> 'id', 'name', coalesce(i ->> 'name', ''), 'cat', coalesce(i ->> 'cat', ''),
      'price', pos.num(i -> 'price'), 'stock', greatest(0, floor(pos.num(i -> 'stock'))),
      'emoji', left(coalesce(nullif(i ->> 'emoji', ''), '🍽️'), 8),
      'img', case when (i ->> 'img') ~ '^data:image/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$' then i ->> 'img' else '' end) order by o), '[]')
    into items from jsonb_array_elements(d -> 'items') with ordinality t(i, o);
  select coalesce(array_agg(c order by o), '{}') into ucats from (select c, min(o) o from
    (select coalesce(i ->> 'cat', '') c, o from jsonb_array_elements(d -> 'items') with ordinality t(i, o)) z group by c) y;
  select coalesce(array_agg(c order by o), '{}') into ccats from jsonb_array_elements_text(case when jsonb_typeof(d -> 'cats') = 'array' then d -> 'cats' else '[]'::jsonb end) with ordinality t(c, o);
  foreach x in array ccats loop if x = any (ucats) then res := res || x; end if; end loop;
  foreach x in array ucats loop if not (x = any (ccats)) then res := res || x; end if; end loop;
  return pos.r(200, jsonb_build_object('ver', v, 'store', coalesce(nullif(s ->> 'store', ''), 'POS SATE'),
    'logo', case when (s ->> 'logo') ~ '^data:image/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$' then s ->> 'logo' else 'icon-192.png' end,
    'cur', coalesce(nullif(s ->> 'cur', ''), 'Rp'), 'curPos', case when s ->> 'curPos' = 'after' then 'after' else 'before' end,
    'dec', greatest(0, least(4, pos.num(s -> 'dec'))), 'loc', coalesce(nullif(s ->> 'loc', ''), 'id-ID'),
    'tax', pos.num(s -> 'tax'), 'pay', pos.pay_cfg(s), 'cats', to_jsonb(res), 'items', items, 'open', st -> 'on', 'msg', st -> 'msg'));
end $$;

create or replace function pos.create_order(b jsonb, v_ip text) returns jsonb language plpgsql as $$
declare st jsonb := pos.co_set(); d jsonb; s jsonb; nm text; kk text; ex pos.co; lim int; ids text[] := '{}'; qts int[] := '{}';
  it jsonb; iid text; qty int; ix int; item jsonb; dec int; sub numeric := 0; tx numeric; tot numeric; lines jsonb := '[]'; stock numeric;
  tk text; n int; v_day date; r pos.co; tp text; tx_pct numeric; v_pay text := '';
begin
  perform pg_advisory_xact_lock(7001);
  if not (st ->> 'on')::boolean then return pos.r(403, jsonb_build_object('error', 'closed', 'msg', st -> 'msg')); end if;
  select json into d from pos.doc where id = 1;
  if d is null then return pos.r(503, '{"error":"belum siap"}'); end if;
  if jsonb_typeof(b -> 'website') = 'string' and (b ->> 'website') <> '' then return pos.r(400, '{"error":"ditolak"}'); end if;
  nm := pos.clean(b ->> 'name', 40);
  if nm = '' then return pos.r(400, '{"error":"Nama wajib diisi"}'); end if;
  kk := nullif(pos.clean(b ->> 'key', 64), '');
  if kk is not null then
    select * into ex from pos.co where idem = kk;
    if ex.id is not null then return pos.r(200, jsonb_build_object('tok', ex.tok) || pos.cust_view(ex) || '{"dup":true}'); end if;
  end if;
  lim := greatest(1, coalesce((select (v #>> '{}')::int from pos.meta where meta.k = 'order_rate'), 40));
  delete from pos.hits where t < now() - interval '10 minutes';
  if (select count(*) from pos.hits where hits.ip = v_ip) >= lim then
    return pos.r(429, '{"error":"Terlalu banyak pesanan. Coba lagi beberapa menit lagi."}');
  end if;
  insert into pos.hits(ip) values (v_ip);
  if (select count(*) from pos.co where status = 'new') >= 300 then return pos.r(429, '{"error":"Antrean penuh, mohon panggil pelayan."}'); end if;
  if jsonb_typeof(b -> 'items') <> 'array' or jsonb_array_length(b -> 'items') = 0 or jsonb_array_length(b -> 'items') > 60 then
    return pos.r(400, '{"error":"Pesanan kosong"}');
  end if;
  s := coalesce(d -> 'set', '{}'); dec := greatest(0, least(4, pos.num(s -> 'dec')))::int;
  for it in select x from jsonb_array_elements(b -> 'items') x loop
    iid := case when jsonb_typeof(it) = 'object' then it ->> 'id' end;
    qty := floor(case when jsonb_typeof(it) = 'object' then pos.num(it -> 'qty') else 0 end);
    if iid is null or qty < 1 or not exists (select 1 from jsonb_array_elements(d -> 'items') x where x ->> 'id' = iid) then
      return pos.r(400, '{"error":"Item tidak valid"}');
    end if;
    ix := array_position(ids, iid);
    if ix is null then ids := ids || iid; qts := qts || least(99, qty); else qts[ix] := least(99, qts[ix] + qty); end if;
  end loop;
  for ix in 1 .. coalesce(array_length(ids, 1), 0) loop
    select x into item from jsonb_array_elements(d -> 'items') x where x ->> 'id' = ids[ix] limit 1;
    stock := greatest(0, floor(pos.num(item -> 'stock')));
    if stock < qts[ix] then
      return pos.r(409, jsonb_build_object('error', case when stock <= 0 then coalesce(item ->> 'name', '') || ' sudah habis'
        else coalesce(item ->> 'name', '') || ' tinggal ' || stock end, 'id', ids[ix], 'stock', stock));
    end if;
    lines := lines || jsonb_build_array(jsonb_build_object('id', ids[ix], 'name', coalesce(item ->> 'name', ''), 'price', pos.num(item -> 'price'), 'qty', qts[ix]));
    sub := sub + pos.num(item -> 'price') * qts[ix];
  end loop;
  sub := round(sub, dec); tx_pct := pos.num(s -> 'tax');
  tx := round(sub * tx_pct / 100, dec); tot := round(sub + tx, dec);
  v_day := (now() at time zone pos.tz())::date;
  select count(*) + 1 into n from pos.co where co.day = v_day;
  if b ->> 'pay' = 'duitnow' then
    if not (pos.pay_cfg(s) ->> 'on')::boolean then return pos.r(400, '{"error":"Pembayaran online sedang tidak tersedia. Silakan bayar di kasir."}'); end if;
    v_pay := 'duitnow';
  end if;
  tk := encode(extensions.gen_random_bytes(16), 'hex');
  tp := case when b ->> 'type' = 'Dine In' then 'Dine In' else 'Takeaway' end;
  insert into pos.co(tok, idem, day, num, name, tbl, type, note, lines, sub, tax, total, pay)
    values (tk, kk, v_day, '#' || lpad(n::text, 3, '0'), nm, pos.clean(b ->> 'table', 12), tp, pos.clean(b ->> 'note', 200), lines, sub, tx, tot, v_pay)
    returning * into r;
  if random() < 0.05 then delete from pos.co where status in ('done', 'cancelled') and updated_at < now() - interval '30 days'; end if;
  perform pos.bump();
  return pos.r(200, jsonb_build_object('tok', tk) || pos.cust_view(r));
end $$;

-- ------------------------------------------------------------ login
create or replace function pos.login(b jsonb) returns jsonb language plpgsql as $$
declare v_ip text := pos.client_ip(); lu timestamptz; un text; u pos.users; pw text; good boolean := false;
begin
  select until into lu from pos.fails where ip = v_ip;
  if lu is not null and lu > now() then return pos.r(429, '{"error":"terlalu banyak percobaan"}'); end if;
  un := lower(btrim(coalesce(b ->> 'username', '')));
  pw := case when jsonb_typeof(b -> 'password') = 'string' then b ->> 'password' end;
  if un <> '' then select * into u from pos.users where username = un; end if;
  if u.id is not null and pw is not null then good := (u.pw = extensions.crypt(pw, u.pw));
  else perform extensions.crypt('x', '$2a$10$abcdefghijklmnopqrstuu'); end if;
  if not good then
    insert into pos.fails(ip, n) values (v_ip, 1) on conflict (ip) do update set
      n = case when pos.fails.n + 1 >= 8 then 0 else pos.fails.n + 1 end,
      until = case when pos.fails.n + 1 >= 8 then now() + interval '10 minutes' else pos.fails.until end;
    perform pos.audit(null, null, 'login-gagal', left(un, 40) || ' dari ' || v_ip);
    return pos.r(401, '{"error":"username atau sandi salah"}');
  end if;
  delete from pos.fails where ip = v_ip;
  if not u.active then return pos.r(403, '{"error":"Akun dinonaktifkan. Hubungi owner."}'); end if;
  update pos.users set last_login = now() where id = u.id;
  perform pos.audit(u.id, u.username, 'login', v_ip);
  select * into u from pos.users where id = u.id;
  return pos.r(200, jsonb_build_object('token', pos.new_session(u.id), 'days', 90, 'me', pos.me_view(u)));
end $$;

-- ------------------------------------------------------------ router utama
create or replace function pos.route(m text, u text, q jsonb, b jsonb, t text) returns jsonb language plpgsql as $$
declare me pos.users; mt text[]; r pos.co; tu pos.users; own boolean; nrole text; act boolean; nm text; nperms jsonb; un text;
  d pos.doc; gerr text; nv int; cnt int; rv bigint; wt numeric; ms bigint; x jsonb;
begin
  if u = '/api/health' then return pos.r(200, '{"ok":true,"pos":true,"sb":true}'); end if;
  if u = '/api/login' and m = 'POST' then return pos.login(b); end if;
  if u = '/api/public/menu' and m = 'GET' then return pos.pub_menu(q); end if;
  if u = '/api/public/order' and m = 'POST' then return pos.create_order(b, pos.client_ip()); end if;
  mt := regexp_match(u, '^/api/public/order/([A-Za-z0-9_-]{10,40})(/cancel|/paid)?$');
  if mt is not null then
    select * into r from pos.co where tok = mt[1];
    if r.id is null then return pos.r(404, '{"error":"tidak ada"}'); end if;
    if mt[2] = '/paid' then
      if m <> 'POST' then return pos.r(405, '{"error":"method"}'); end if;
      if r.pay <> 'duitnow' or r.status not in ('new', 'accepted') then return pos.r(409, '{"error":"Pesanan ini tidak bisa dibayar online."}'); end if;
      if r.pst = 0 then
        update pos.co set pst = 1, updated_at = now() where id = r.id returning * into r;
        perform pos.bump();
      end if;
      return pos.r(200, pos.cust_view(r));
    end if;
    if mt[2] is not null then
      if m <> 'POST' then return pos.r(405, '{"error":"method"}'); end if;
      if r.pst = 2 then return pos.r(409, jsonb_build_object('error', 'Pembayaran sudah dikonfirmasi, hubungi kasir.', 'status', r.status)); end if;
      if r.status <> 'new' then return pos.r(409, jsonb_build_object('error', 'Pesanan sudah diproses, hubungi kasir.', 'status', r.status)); end if;
      update pos.co set status = 'cancelled', updated_at = now() where id = r.id returning * into r;
      perform pos.bump();
      return pos.r(200, pos.cust_view(r));
    end if;
    if m = 'GET' then return pos.r(200, pos.cust_view(r)); end if;
  end if;

  me := pos.auth(t);
  if me.id is null then return pos.r(401, '{"error":"unauthorized"}'); end if;
  own := me.role = 'owner';

  if u = '/api/me' and m = 'GET' then return pos.r(200, pos.me_view(me)); end if;
  if u = '/api/me/password' and m = 'POST' then
    if coalesce(jsonb_typeof(b -> 'new'), '') <> 'string' or length(b ->> 'new') < 6 then return pos.r(400, '{"error":"Sandi baru minimal 6 karakter"}'); end if;
    if me.pw <> extensions.crypt(coalesce(b ->> 'old', ''), me.pw) then return pos.r(403, '{"error":"Sandi lama salah"}'); end if;
    update pos.users set pw = extensions.crypt(b ->> 'new', extensions.gen_salt('bf', 10)) where id = me.id;
    delete from pos.sessions where uid = me.id;
    perform pos.audit(me.id, me.username, 'ganti-sandi', '');
    return pos.r(200, jsonb_build_object('token', pos.new_session(me.id)));
  end if;

  if u = '/api/users' and m = 'GET' then
    if not own then return pos.r(403, '{"error":"Anda tidak punya akses untuk ini"}'); end if;
    return pos.r(200, jsonb_build_object('perms', '["co","inv","hist","prn","set"]'::jsonb,
      'users', coalesce((select jsonb_agg(pos.me_view(uu) order by (uu.role = 'owner') desc, uu.username) from pos.users uu), '[]')));
  end if;
  if u = '/api/users' and m = 'POST' then
    if not own then return pos.r(403, '{"error":"Anda tidak punya akses untuk ini"}'); end if;
    un := lower(btrim(coalesce(b ->> 'username', ''))); nm := coalesce(nullif(pos.clean(b ->> 'name', 40), ''), un);
    if un !~ '^[a-z0-9][a-z0-9._-]{2,23}$' then return pos.r(400, '{"error":"Username 3-24 karakter: huruf kecil, angka, titik, strip, garis bawah"}'); end if;
    if coalesce(jsonb_typeof(b -> 'password'), '') <> 'string' or length(b ->> 'password') < 6 then return pos.r(400, '{"error":"Sandi minimal 6 karakter"}'); end if;
    if exists (select 1 from pos.users where username = un) then return pos.r(409, '{"error":"Username sudah dipakai"}'); end if;
    nrole := case when b ->> 'role' = 'owner' then 'owner' else 'staff' end;
    nperms := case when nrole = 'owner' then '[]'::jsonb
      else pos.clean_perms(case when b -> 'perms' is null or jsonb_typeof(b -> 'perms') = 'null' then '["co","prn"]'::jsonb else b -> 'perms' end) end;
    insert into pos.users(username, name, role, perms, pw) values (un, nm, nrole, nperms, extensions.crypt(b ->> 'password', extensions.gen_salt('bf', 10))) returning * into tu;
    perform pos.audit(me.id, me.username, 'tambah-user', un || ' (' || nrole || ')');
    return pos.r(200, pos.me_view(tu));
  end if;
  mt := regexp_match(u, '^/api/users/(\d{1,15})$');
  if mt is not null and m in ('PUT', 'DELETE') then
    if not own then return pos.r(403, '{"error":"Anda tidak punya akses untuk ini"}'); end if;
    select * into tu from pos.users where id = mt[1]::bigint;
    if tu.id is null then return pos.r(404, '{"error":"pengguna tidak ada"}'); end if;
    select count(*) into cnt from pos.users where users.role = 'owner' and users.active;
    if m = 'DELETE' then
      if tu.id = me.id then return pos.r(400, '{"error":"Tidak bisa menghapus akun sendiri"}'); end if;
      if tu.role = 'owner' and tu.active and cnt <= 1 then return pos.r(400, '{"error":"Harus ada minimal satu owner aktif"}'); end if;
      delete from pos.users where id = tu.id;
      perform pos.audit(me.id, me.username, 'hapus-user', tu.username);
      return pos.r(200, '{"ok":true}');
    end if;
    nrole := case when b ? 'role' then (case when b ->> 'role' = 'owner' then 'owner' else 'staff' end) else tu.role end;
    act := case when b ? 'active' then coalesce((b ->> 'active') in ('true', '1'), false) else tu.active end;
    nm := case when b ? 'name' then coalesce(nullif(pos.clean(b ->> 'name', 40), ''), tu.name) else tu.name end;
    nperms := case when nrole = 'owner' then '[]'::jsonb else pos.clean_perms(case when b ? 'perms' then b -> 'perms' else tu.perms end) end;
    if tu.role = 'owner' and tu.active and (nrole <> 'owner' or not act) and cnt <= 1 then return pos.r(400, '{"error":"Harus ada minimal satu owner aktif"}'); end if;
    if tu.id = me.id and (nrole <> 'owner' or not act) then return pos.r(400, '{"error":"Tidak bisa menurunkan/menonaktifkan akun sendiri"}'); end if;
    if b ? 'password' and (coalesce(jsonb_typeof(b -> 'password'), '') <> 'string' or length(b ->> 'password') < 6) then return pos.r(400, '{"error":"Sandi minimal 6 karakter"}'); end if;
    update pos.users set name = nm, role = nrole, perms = nperms, active = act where id = tu.id;
    if nrole <> tu.role or (not act and tu.active) then delete from pos.sessions where uid = tu.id; end if;
    if b ? 'password' then
      update pos.users set pw = extensions.crypt(b ->> 'password', extensions.gen_salt('bf', 10)) where id = tu.id;
      delete from pos.sessions where uid = tu.id;
      perform pos.audit(me.id, me.username, 'reset-sandi', tu.username);
    end if;
    perform pos.audit(me.id, me.username, 'ubah-user', tu.username || ' role=' || nrole || ' aktif=' || (case when act then 1 else 0 end) || ' izin=' || (select coalesce(string_agg(e, ','), '') from jsonb_array_elements_text(nperms) e));
    select * into tu from pos.users where id = tu.id;
    return pos.r(200, pos.me_view(tu));
  end if;
  if u = '/api/audit' and m = 'GET' then
    if not own then return pos.r(403, '{"error":"Anda tidak punya akses untuk ini"}'); end if;
    return pos.r(200, jsonb_build_object('log', coalesce((select jsonb_agg(jsonb_build_object('t', pos.iso(a.t), 'uname', a.uname, 'action', a.action, 'detail', a.detail) order by a.id desc)
      from (select * from pos.audit order by id desc limit 100) a), '[]')));
  end if;

  -- pesanan online (kasir)
  if u like '/api/co%' and not pos.can(me, 'co') then return pos.r(403, '{"error":"Anda tidak punya izin Pesanan Online"}'); end if;
  if u = '/api/co' and m = 'GET' then
    rv := pos.rev(); wt := least(25, pos.num(q -> 'wait'));
    if pos.num(q -> 'rev') = rv and wt > 0 then return pos.r(200, jsonb_build_object('rev', rv, 'unchanged', true)); end if;
    return pos.r(200, jsonb_build_object('rev', rv, 'set', pos.co_set(), 'orders', coalesce((select jsonb_agg(pos.staff_view(c) order by c.id desc)
      from (select * from pos.co where status in ('new', 'accepted') or updated_at > now() - interval '2 days' order by id desc limit 200) c), '[]')));
  end if;
  if u = '/api/co/settings' and m = 'PUT' then
    if not pos.can(me, 'set') then return pos.r(403, '{"error":"Hanya owner atau pengguna dengan izin Pengaturan yang boleh membuka/menutup pemesanan"}'); end if;
    insert into pos.meta(k, v) values ('co', jsonb_build_object('on', not (b ? 'on' and b -> 'on' = 'false'::jsonb), 'msg', pos.clean(b ->> 'msg', 200)))
      on conflict (k) do update set v = excluded.v;
    perform pos.bump();
    return pos.r(200, pos.co_set());
  end if;
  mt := regexp_match(u, '^/api/co/(\d{1,15})(?:/(print))?$');
  if mt is not null and m = 'POST' then
    select * into r from pos.co where id = mt[1]::bigint;
    if r.id is null then return pos.r(404, '{"error":"tidak ada"}'); end if;
    if mt[2] is not null then
      ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
      if b ->> 'action' = 'claim' then
        update pos.co set printed = 1, claim_at = ms where id = r.id and (printed = 0 or (printed = 1 and claim_at < ms - 90000));
        get diagnostics cnt = row_count;
        return pos.r(200, jsonb_build_object('ok', cnt = 1));
      elsif b ->> 'action' = 'done' then update pos.co set printed = 2 where id = r.id;
      elsif b ->> 'action' = 'release' then update pos.co set printed = 0 where id = r.id and printed = 1;
      elsif b ->> 'action' = 'reset' then update pos.co set printed = 0 where id = r.id;
      else return pos.r(400, '{"error":"aksi?"}'); end if;
      perform pos.bump();
      return pos.r(200, '{"ok":true}');
    end if;
    if b ->> 'action' in ('paid', 'unpaid') then
      if r.pay <> 'duitnow' then return pos.r(400, '{"error":"bukan pesanan bayar online"}'); end if;
      if r.status = 'cancelled' then return pos.r(409, jsonb_build_object('error', 'sudah selesai', 'status', r.status)); end if;
      update pos.co set pst = case when b ->> 'action' = 'paid' then 2 else 0 end, updated_at = now() where id = r.id returning * into r;
      perform pos.bump();
      return pos.r(200, pos.staff_view(r));
    end if;
    nm := case b ->> 'action' when 'accept' then 'accepted' when 'cancel' then 'cancelled' when 'done' then 'done' end;
    if nm is null then return pos.r(400, '{"error":"aksi?"}'); end if;
    if r.status in ('done', 'cancelled') then return pos.r(409, jsonb_build_object('error', 'sudah selesai', 'status', r.status)); end if;
    update pos.co set status = nm, sale_no = coalesce(nullif(pos.clean(b ->> 'saleNo', 40), ''), sale_no), updated_at = now() where id = r.id returning * into r;
    perform pos.bump();
    return pos.r(200, pos.staff_view(r));
  end if;

  if u = '/api/version' and m = 'GET' then return pos.r(200, jsonb_build_object('version', (select version from pos.doc where id = 1))); end if;
  if u = '/api/data' and m = 'GET' then
    select * into d from pos.doc where id = 1;
    if q ->> 'since' = d.version::text and d.version > 0 then return pos.r(200, jsonb_build_object('version', d.version, 'unchanged', true)); end if;
    return pos.r(200, jsonb_build_object('version', d.version, 'updatedAt', pos.iso(d.updated_at), 'data', d.json));
  end if;
  if u = '/api/data' and m = 'PUT' then
    x := b -> 'data';
    if not coalesce(pos.valid_doc(x), false) or jsonb_typeof(b -> 'baseVersion') <> 'number' or (b ->> 'baseVersion')::numeric <> trunc((b ->> 'baseVersion')::numeric) then
      return pos.r(400, '{"error":"data tidak valid"}');
    end if;
    select * into d from pos.doc where id = 1 for update;
    gerr := pos.guard(me, d.json, x);
    if gerr is not null then perform pos.audit(me.id, me.username, 'ditolak', gerr); return pos.r(403, jsonb_build_object('error', gerr)); end if;
    if (b ->> 'baseVersion')::numeric <> d.version then return pos.r(409, jsonb_build_object('conflict', true, 'version', d.version, 'data', d.json)); end if;
    if d.json is not null then
      insert into pos.snapshots(day, json, version) values ((now() at time zone 'UTC')::date, d.json, d.version) on conflict do nothing;
      delete from pos.snapshots where day not in (select day from pos.snapshots order by day desc limit 30);
    end if;
    nv := d.version + 1;
    update pos.doc set json = x, version = nv, updated_at = now() where id = 1;
    return pos.r(200, jsonb_build_object('version', nv, 'updatedAt', pos.iso(now())));
  end if;

  if (u = '/api/export' or u like '/api/snapshots%') and not own then return pos.r(403, '{"error":"Khusus owner"}'); end if;
  if u = '/api/export' and m = 'GET' then return pos.r(200, coalesce((select json from pos.doc where id = 1), '{}'::jsonb)); end if;
  if u = '/api/snapshots' and m = 'GET' then
    return pos.r(200, jsonb_build_object('snapshots', coalesce((select jsonb_agg(jsonb_build_object('day', to_char(s.day, 'YYYY-MM-DD'), 'version', s.version,
      'created_at', pos.iso(s.created_at), 'size', octet_length(s.json::text)) order by s.day desc) from pos.snapshots s), '[]')));
  end if;
  mt := regexp_match(u, '^/api/snapshots/(\d{4}-\d{2}-\d{2})$');
  if mt is not null and m = 'GET' then
    begin
      select jsonb_build_object('version', s.version, 'data', s.json) into x from pos.snapshots s where s.day = mt[1]::date;
    exception when others then x := null; end;
    if x is null then return pos.r(404, '{"error":"tidak ada"}'); end if;
    return pos.r(200, x);
  end if;
  return pos.r(404, '{"error":"not found"}');
end $$;

-- ------------------------------------------------------------ satu-satunya pintu publik
create or replace function public.pos_api(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_typeof(p) <> 'object' then return pos.r(400, '{"error":"bad request"}'); end if;
  return pos.route(upper(coalesce(p ->> 'm', 'GET')), coalesce(p ->> 'u', ''),
    case when jsonb_typeof(p -> 'q') = 'object' then p -> 'q' else '{}'::jsonb end,
    case when jsonb_typeof(p -> 'b') = 'object' then p -> 'b' else '{}'::jsonb end, p ->> 't');
exception when others then
  return pos.r(500, jsonb_build_object('error', 'server error',
    'detail', case when exists (select 1 from pos.meta where k = 'debug') then sqlerrm end));
end $$;

-- ------------------------------------------------------------ hak akses
revoke all on schema pos from public, anon, authenticated;
revoke all on all tables in schema pos from public, anon, authenticated;
revoke all on all functions in schema pos from public, anon, authenticated;
revoke all on function public.pos_api(jsonb) from public;
grant execute on function public.pos_api(jsonb) to anon, authenticated;

-- ------------------------------------------------------------ alat admin (hanya dari SQL Editor)
-- Buat / pulihkan akun owner:   select pos.admin_owner('owner', 'sandi-anda-minimal-6');
create or replace function pos.admin_owner(nun text, npw text) returns text language plpgsql as $$
declare u pos.users; un text; vpw text;
begin
  un := lower(btrim(nun)); vpw := npw;
  if un !~ '^[a-z0-9][a-z0-9._-]{2,23}$' then raise exception 'username 3-24 karakter: huruf kecil/angka . _ -'; end if;
  if length(coalesce(vpw, '')) < 6 or vpw = 'ganti-dengan-sandi-yang-kuat' then raise exception 'sandi minimal 6 karakter dan jangan memakai contoh'; end if;
  select * into u from pos.users where users.username = un;
  if u.id is null then
    insert into pos.users(username, name, role, perms, pw) values (un, initcap(un), 'owner', '[]', extensions.crypt(vpw, extensions.gen_salt('bf', 10)));
    perform pos.audit(null, null, 'admin', 'owner dibuat: ' || un);
    return 'owner dibuat: ' || un;
  end if;
  update pos.users set role = 'owner', active = true, perms = '[]', pw = extensions.crypt(vpw, extensions.gen_salt('bf', 10)) where id = u.id;
  delete from pos.sessions where uid = u.id;
  perform pos.audit(null, null, 'admin', 'sandi owner direset: ' || un);
  return 'sandi owner direset: ' || un;
end $$;
-- Zona waktu toko (nomor antrean harian):  select pos.admin_tz('Asia/Makassar');
create or replace function pos.admin_tz(z text) returns text language plpgsql as $$
begin
  perform now() at time zone z;
  insert into pos.meta(k, v) values ('tz', to_jsonb(z)) on conflict (k) do update set v = excluded.v;
  return 'zona waktu: ' || z;
end $$;
revoke all on all functions in schema pos from public, anon, authenticated;
