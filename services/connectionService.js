import Soultee from "../models/Soultee.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";

const soulteeStatusRank = {
  online: 0,
  busy: 1,
  offline: 2,
};

function sortSoultees(left, right) {
  const leftRank = soulteeStatusRank[left.status] ?? 99;
  const rightRank = soulteeStatusRank[right.status] ?? 99;

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return (right.rating || 0) - (left.rating || 0);
}

function toDirectoryEntry(soultee, link) {
  const requestStatus = link?.status === "active"
    ? "accepted"
    : link?.status === "declined"
      ? "rejected"
      : link?.status || "none";

  return {
    ...soultee,
    requestId: link?._id || null,
    requestStatus,
    connectionStatus: link?.status || "none",
    requestedAt: link?.requestedAt || null,
    acceptedAt: link?.acceptedAt || null,
    roomId: link?.status === "active" ? String(link._id) : null,
  };
}

export async function getSoulteeDirectory(studentUid, filter = {}) {
  const soultees = await Soultee.find(filter)
    .select("-__v")
    .lean();

  if (!studentUid || soultees.length === 0) {
    return soultees.sort(sortSoultees);
  }

  const soulteeUids = soultees
    .map((soultee) => soultee.firebaseUid)
    .filter(Boolean);

  const links = await StudentSoulteeLink.find({
    studentFirebaseUid: studentUid,
    soulteeFirebaseUid: { $in: soulteeUids },
  })
    .select("_id soulteeFirebaseUid status requestedAt acceptedAt")
    .lean();

  const linksBySoulteeUid = new Map(
    links.map((link) => [link.soulteeFirebaseUid, link])
  );

  return soultees
    .map((soultee) => toDirectoryEntry(soultee, linksBySoulteeUid.get(soultee.firebaseUid)))
    .sort(sortSoultees);
}

export async function getStudentConnections(studentUid) {
  const links = await StudentSoulteeLink.find({
    studentFirebaseUid: studentUid,
    status: "active",
  })
    .sort({ acceptedAt: -1 })
    .lean();

  if (links.length === 0) {
    return [];
  }

  const soulteeUids = links.map((link) => link.soulteeFirebaseUid);
  const soultees = await Soultee.find({ firebaseUid: { $in: soulteeUids } })
    .select("firebaseUid name status specialization profileImage rating languages bio")
    .lean();

  const soulteesByUid = new Map(
    soultees.map((soultee) => [soultee.firebaseUid, soultee])
  );

  return links.map((link) => ({
    linkId: link._id,
    roomId: String(link._id),
    studentFirebaseUid: link.studentFirebaseUid,
    studentName: link.studentName,
    soulteeFirebaseUid: link.soulteeFirebaseUid,
    requestStatus: "accepted",
    connectionStatus: link.status,
    acceptedAt: link.acceptedAt,
    soultee: soulteesByUid.get(link.soulteeFirebaseUid) || null,
  }));
}