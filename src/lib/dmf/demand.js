// CPHI sourcing — clinical-demand scoring for a molecule. Pure function, no DB.
//
// Ranks molecules by how much API a recruiting trial pipeline is going to need. The inputs are
// the only demand signals clinical_studies actually carries: how many recruiting studies name
// the molecule, how many patients those studies plan to enrol, and what phase they are in.
//
// WEIGHTS, and why:
//   studies  x3   breadth. Several sponsors independently needing the same molecule is a
//                 stronger sourcing signal than one big trial.
//   phase 3  x5   a Phase 3 needs commercial-scale, GMP, DMF-backed material. This is the
//                 signal that actually predicts an API purchase.
//   phase 2  x2   real but smaller volume.
//   patients      capped contribution (patients/500, max 20). Uncapped, one 40,000-patient
//                 cardiovascular outcomes trial would outrank every oncology molecule in the
//                 set, and oncology is where the sourcing margin is. The cap keeps enrolment
//                 as a tie-breaker rather than the ranking.
//
// Phase is NULL on 775 of 1,457 studies, so the phase terms are a bonus, never a filter — a
// molecule with unphased studies still ranks on breadth and enrolment.
//
// The exact weights are a judgement call, not a fact. Measured sensitivity: ranking by the
// composite, by study count alone, or by enrolment alone changes the resulting distinct-holder
// count only between 266 and 307, so downstream sizing does not hinge on them.

const PATIENT_DIVISOR = 500;
const PATIENT_CAP = 20;

function demandScore({ studies = 0, phase3 = 0, phase2 = 0, patients = 0 }) {
  return studies * 3 + phase3 * 5 + phase2 * 2 + Math.min(patients / PATIENT_DIVISOR, PATIENT_CAP);
}

/** SQL fragment for the same score, so the report and any future query stay in step. */
const DEMAND_SQL = `(studies * 3 + ph3 * 5 + ph2 * 2 + least(patients / ${PATIENT_DIVISOR}.0, ${PATIENT_CAP}))`;

module.exports = { demandScore, DEMAND_SQL, PATIENT_DIVISOR, PATIENT_CAP };
