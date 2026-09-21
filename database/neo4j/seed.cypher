// Clear existing NeuroLearn graph data
MATCH (n)
DETACH DELETE n;

// Create concepts
CREATE
    (linearAlgebra:Concept {
        concept_id: "C001",
        name: "Linear Algebra",
        description: "Fundamental concepts of linear algebra.",
        difficulty_level: "Beginner"
    }),

    (vectors:Concept {
        concept_id: "C002",
        name: "Vectors",
        description: "Vectors and their basic operations.",
        difficulty_level: "Beginner"
    }),

    (matrices:Concept {
        concept_id: "C003",
        name: "Matrices",
        description: "Matrix representation and operations.",
        difficulty_level: "Beginner"
    }),

    (matrixOperations:Concept {
        concept_id: "C004",
        name: "Matrix Operations",
        description: "Addition, subtraction and multiplication of matrices.",
        difficulty_level: "Intermediate"
    }),

    (determinants:Concept {
        concept_id: "C005",
        name: "Determinants",
        description: "Calculation and interpretation of determinants.",
        difficulty_level: "Intermediate"
    }),

    (calculus:Concept {
        concept_id: "C006",
        name: "Calculus",
        description: "Fundamental concepts of calculus.",
        difficulty_level: "Beginner"
    }),

    (limits:Concept {
        concept_id: "C007",
        name: "Limits",
        description: "Introduction to limits and their applications.",
        difficulty_level: "Beginner"
    }),

    (derivatives:Concept {
        concept_id: "C008",
        name: "Derivatives",
        description: "Differentiation and applications of derivatives.",
        difficulty_level: "Intermediate"
    });

// Create prerequisite relationships
CREATE
    (vectors)-[:PREREQUISITE_OF]->(matrices),
    (matrices)-[:PREREQUISITE_OF]->(matrixOperations),
    (matrixOperations)-[:PREREQUISITE_OF]->(determinants),
    (limits)-[:PREREQUISITE_OF]->(derivatives);

// Create broader concept relationships
CREATE
    (linearAlgebra)-[:CONTAINS]->(vectors),
    (linearAlgebra)-[:CONTAINS]->(matrices),
    (linearAlgebra)-[:CONTAINS]->(matrixOperations),
    (linearAlgebra)-[:CONTAINS]->(determinants),
    (calculus)-[:CONTAINS]->(limits),
    (calculus)-[:CONTAINS]->(derivatives);