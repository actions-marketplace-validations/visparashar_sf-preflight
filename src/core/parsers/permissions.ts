// SPDX-License-Identifier: Apache-2.0
import type { PermissionContainerDef } from "../types.js";
import { bool, nodes, parseMetadataXml, text } from "../util.js";

/** Parse a `.permissionset-meta.xml` or `.profile-meta.xml` file. */
export function parsePermissionContainer(
  xml: string,
  name: string,
  kind: "PermissionSet" | "Profile",
  file: string,
): PermissionContainerDef {
  const { body } = parseMetadataXml(xml);
  return {
    name,
    kind,
    objects: nodes(body.objectPermissions)
      .map((o) => ({
        object: text(o.object) ?? "",
        read: bool(o.allowRead),
        create: bool(o.allowCreate),
        edit: bool(o.allowEdit),
        delete: bool(o.allowDelete),
        viewAll: bool(o.viewAllRecords),
        modifyAll: bool(o.modifyAllRecords),
      }))
      .filter((o) => o.object),
    fields: nodes(body.fieldPermissions)
      .map((f) => ({
        field: text(f.field) ?? "",
        readable: bool(f.readable),
        editable: bool(f.editable),
      }))
      .filter((f) => f.field),
    userPermissions: nodes(body.userPermissions)
      .filter((u) => bool(u.enabled))
      .map((u) => text(u.name) ?? "")
      .filter(Boolean),
    file,
  };
}
