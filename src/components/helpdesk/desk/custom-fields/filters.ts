"use client";

// The custom field definitions as the queue's filters need them (1.20.8,
// lib/helpdesk/custom-field-filters): the Filter dialog's field picker and
// the filter strip's words ("Device type: Laptop, Phone"). One read per page
// load, shared by every caller, as the categories list does. People's names
// for "A person" conditions come from the workspace's people list, read
// only when a condition names someone.

import { useEffect, useMemo, useState } from "react";
import { getJson } from "../api";
import { cfFieldKey, isCfFilterKey, type HdCfFilterField } from "@/lib/helpdesk/custom-field-filters-shared";

export interface DeskFilterField extends HdCfFilterField {
  all_teams: boolean;
  team_ids: number[];
}

let cache: Promise<DeskFilterField[]> | null = null;

function load(): Promise<DeskFilterField[]> {
  cache ??= getJson<{ fields?: DeskFilterField[] }>("/api/helpdesk/custom-fields")
    .then((d) => (Array.isArray(d?.fields) ? d.fields : []))
    .catch(() => {
      cache = null;
      return [];
    });
  return cache;
}

/** Every custom field, archived ones marked; undefined until loaded. */
export function useDeskFilterFields(): DeskFilterField[] | undefined {
  const [fields, setFields] = useState<DeskFilterField[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void load().then((f) => live && setFields(f));
    return () => {
      live = false;
    };
  }, []);
  return fields;
}

let people: Promise<Map<number, string>> | null = null;

function loadPeople(): Promise<Map<number, string>> {
  people ??= getJson<{ users?: { id: number; name: string; username: string }[] }>("/api/users/mentionable")
    .then((d) => new Map((d?.users ?? []).map((u) => [u.id, u.name || u.username] as [number, string])))
    .catch(() => {
      people = null;
      return new Map<number, string>();
    });
  return people;
}

/** Names for the people "A person" conditions in `filters` name; empty until read (and never read when none does). */
export function useFilterPeopleNames(filters: Record<string, string> | null | undefined, fields: DeskFilterField[] | undefined): Map<number, string> {
  const needs = useMemo(
    () =>
      !!filters &&
      !!fields &&
      Object.entries(filters).some(([k, v]) => isCfFilterKey(k) && v.startsWith("is:") && fields.find((f) => f.key === cfFieldKey(k))?.type === "user"),
    [filters, fields]
  );
  const [names, setNames] = useState<Map<number, string>>(() => new Map());
  useEffect(() => {
    if (!needs) return;
    let live = true;
    void loadPeople().then((m) => live && setNames(m));
    return () => {
      live = false;
    };
  }, [needs]);
  return names;
}
