-- Contacts you can group into lists and send to.
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,          -- lowercase
  name TEXT,
  fields TEXT NOT NULL DEFAULT '{}',   -- JSON of every other column, keys lowercased (first_name, company, …)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  created_at INTEGER NOT NULL
);

-- A contact can be on any number of lists.
CREATE TABLE list_contacts (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX idx_list_contacts_contact ON list_contacts(contact_id);
